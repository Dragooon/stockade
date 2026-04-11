/**
 * Worker agent loop — runs a single agent session and emits events.
 *
 * Design principles:
 * - permissionMode is always "bypassPermissions" — the container/host is the boundary.
 * - All permission checks go through the orchestrator via HTTP PreToolUse callback.
 * - The orchestrator callback also handles HITL — the HTTP call blocks until resolved.
 * - Sub-agent delegation goes through the orchestrator's "agent" MCP server.
 * - The ConversationChannel is the prompt — supports mid-session injection.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename } from "node:path";
import type { ConversationChannel } from "./channel.js";
import type { WorkerSessionRequest, WorkerEvent } from "./types.js";

/**
 * HTTP request using node:http/https directly — bypasses undici/fetch and any
 * proxy configuration that may interfere with internal callback traffic.
 */
function httpCallback(
  method: string,
  url: string,
  body: string | null,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const requester = isHttps ? httpsRequest : httpRequest;
    const hasBody = body !== null && body.length > 0;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: hasBody
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body!) }
        : {},
    };
    const req = requester(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTP callback timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (hasBody) req.write(body!);
    req.end();
  });
}

// Keep httpPost as a convenience wrapper used by the PreToolUse hook.
function httpPost(url: string, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return httpCallback("POST", url, body, timeoutMs);
}

const DEFAULT_MODEL = "sonnet";
const DEFAULT_MAX_TURNS = 20;

const STALE_SESSION_PATTERNS = [
  "No conversation found",
  "session not found",
  "invalid session",
];

function isStaleSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return STALE_SESSION_PATTERNS.some((p) => msg.toLowerCase().includes(p.toLowerCase()));
}

function formatModelUsage(modelUsage: Record<string, Record<string, unknown>>): string {
  return Object.entries(modelUsage)
    .map(([model, u]) => {
      const parts = [`${u.inputTokens ?? 0}in/${u.outputTokens ?? 0}out`];
      if (Number(u.cacheReadInputTokens ?? 0) > 0)
        parts.push(`cache_read:${u.cacheReadInputTokens}`);
      if (Number(u.cacheCreationInputTokens ?? 0) > 0)
        parts.push(`cache_create:${u.cacheCreationInputTokens}`);
      if (u.costUSD != null) parts.push(`$${Number(u.costUSD).toFixed(4)}`);
      return `${model}: ${parts.join(" ")}`;
    })
    .join("; ");
}

/**
 * Run an agent session, emitting events via the provided callback.
 *
 * The `channel` is used as the query() prompt — the caller pushes the initial
 * message (and any mid-session injections) before / during the loop.
 *
 * On stale session: emits `stale_session` and returns (orchestrator retries).
 * On success: emits `result` and returns.
 * On error: propagates the error (caller emits `error`).
 */
export async function runAgentSession(
  request: WorkerSessionRequest,
  channel: ConversationChannel,
  emit: (event: WorkerEvent) => void,
): Promise<void> {
  const { tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
  const { z } = await import("zod");

  const { orchestratorUrl, callbackToken } = request;
  const cbBase = `${orchestratorUrl}/cb/${callbackToken}`;

  /** Files queued by send_file tool calls during this session. */
  const pendingFiles: Array<{ filename: string; contentType: string; path: string }> = [];

  // ── Build agent MCP server: gives the agent mcp__agent__start/stop/message ──
  const agentStartTool = tool(
    "start",
    `Start a sub-agent to handle a task. Returns immediately with a runId.
Use background:true for long-running tasks (result injected when done).
Use background:false (default) to block until the sub-agent returns.
Use inline:true to share the current workspace (no separate isolation).
Omit agentId to self-spawn: starts a parallel copy of this agent in the same workspace
with full memory and settings, ideal for divide-and-conquer reasoning tasks.`,
    {
      agentId: z.string().optional().describe("Agent ID from agents config. Omit to self-spawn a parallel copy of this agent."),
      task: z.string().describe("Task description or prompt for the sub-agent"),
      name: z.string().optional().describe("Name this agent for later messaging via mcp__agent__message"),
      background: z.boolean().optional().describe("Run in background without blocking (default: false)"),
      inline: z.boolean().optional().describe("Share parent workspace instead of isolated workspace (default: false)"),
      model: z.string().optional().describe("Override model for this invocation (e.g. 'sonnet', 'opus'). Use when the default model is insufficient for the task."),
    },
    async (args) => {
      try {
        // Use httpCallback (node:http) to bypass undici ProxyAgent which does not
        // honour noProxyList for plain HTTP, causing "fetch failed" on the callback server.
        const timeoutMs = args.background ? 10_000 : 3_600_000;
        const res = await httpCallback("POST", `${cbBase}/agent/start`, JSON.stringify(args), timeoutMs);
        if (res.status < 200 || res.status >= 300) {
          return { content: [{ type: "text" as const, text: `Error: ${res.text}` }] };
        }
        const data = JSON.parse(res.text) as { runId: string; result?: string };
        if (data.result !== undefined) {
          return { content: [{ type: "text" as const, text: data.result }] };
        }
        return { content: [{ type: "text" as const, text: `Started agent (runId: ${data.runId}). Result will be injected when complete.` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to start agent: ${msg}` }] };
      }
    },
  );

  const agentStopTool = tool(
    "stop",
    "Stop a running sub-agent by its runId.",
    { runId: z.string().describe("runId returned by mcp__agent__start") },
    async (args) => {
      try {
        await httpCallback("POST", `${cbBase}/agent/stop`, JSON.stringify(args), 10_000);
        return { content: [{ type: "text" as const, text: `Agent ${args.runId} stopped.` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to stop agent: ${msg}` }] };
      }
    },
  );

  const agentMessageTool = tool(
    "message",
    "Send a follow-up message to a running sub-agent (by runId or name).",
    {
      target: z.string().describe("runId or name of the target agent"),
      text: z.string().describe("Message to inject into the agent's conversation"),
    },
    async (args) => {
      try {
        const res = await httpCallback("POST", `${cbBase}/agent/message`, JSON.stringify(args), 10_000);
        if (res.status < 200 || res.status >= 300) {
          return { content: [{ type: "text" as const, text: `Error: ${res.text}` }] };
        }
        return { content: [{ type: "text" as const, text: "Message sent." }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to send message: ${msg}` }] };
      }
    },
  );

  const sendFileTool = tool(
    "send_file",
    "Queue a file to be delivered as an attachment in the channel response. The file must already exist on disk.",
    {
      path: z.string().describe("Absolute path to the file"),
      filename: z.string().optional().describe("Filename to display (defaults to basename of path)"),
      content_type: z.string().optional().describe("MIME type (defaults to application/octet-stream)"),
    },
    async (args) => {
      const resolvedFilename = args.filename ?? basename(args.path);
      const contentType = args.content_type ?? "application/octet-stream";
      pendingFiles.push({ path: args.path, filename: resolvedFilename, contentType });
      return { content: [{ type: "text" as const, text: "File queued for delivery" }] };
    },
  );

  const agentMcpServer = createSdkMcpServer({
    name: "agent",
    version: "1.0.0",
    tools: [agentStartTool, agentStopTool, agentMessageTool, sendFileTool],
  });

  // ── Build scheduler MCP server: gives the agent mcp__scheduler__* ──

  const schedulerCreateTool = tool(
    "create",
    `Schedule a task to run on a recurring or one-time basis.
The task will run as the current user in the current channel.
The prompt you provide is sent verbatim to the agent when the task fires.

schedule_type options:
  - "cron":     standard cron expression (e.g. "0 9 * * *" for 9 AM daily)
  - "interval": repeat every N milliseconds (e.g. 7200000 for every 2 hours)
  - "once":     run once at a specific ISO datetime (e.g. "2026-04-10T17:00:00Z")`,
    {
      prompt: z.string().describe("The exact message to send to the agent when this task fires"),
      schedule_type: z.enum(["cron", "interval", "once"]).describe("Schedule type"),
      schedule_value: z.string().describe("Cron expression, interval in ms, or ISO datetime for 'once'"),
      agentId: z.string().optional().describe("Agent to run the task (defaults to current agent)"),
      context_mode: z.enum(["isolated", "agent"]).optional().describe("isolated: fresh session each run (default); agent: resume channel session"),
      timezone: z.string().optional().describe("Timezone for cron expressions (e.g. 'America/New_York'). Defaults to UTC."),
    },
    async (args) => {
      try {
        const res = await httpCallback("POST", `${cbBase}/scheduler/tasks`, JSON.stringify(args), 10_000);
        const data = JSON.parse(res.text) as { task?: { id: string; next_run: string | null }; error?: string };
        if (res.status < 200 || res.status >= 300) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };
        return { content: [{ type: "text" as const, text: `Task created (id: ${data.task!.id}). First run: ${data.task!.next_run ?? "N/A"}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed to create task: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );

  const schedulerListTool = tool(
    "list",
    "List all scheduled tasks.",
    {},
    async () => {
      try {
        const res = await httpCallback("GET", `${cbBase}/scheduler/tasks`, null, 10_000);
        const data = JSON.parse(res.text) as { tasks?: Array<Record<string, unknown>>; error?: string };
        if (res.status < 200 || res.status >= 300) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };
        if (!data.tasks?.length) return { content: [{ type: "text" as const, text: "No scheduled tasks." }] };
        const lines = data.tasks.map((t) =>
          `- ${t.id} | ${t.schedule_type} (${t.schedule_value}) | status: ${t.status} | next: ${t.next_run ?? "done"} | prompt: "${String(t.prompt).slice(0, 60)}"`
        );
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed to list tasks: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );

  const schedulerDeleteTool = tool(
    "delete",
    "Delete a scheduled task by ID.",
    { taskId: z.string().describe("Task ID to delete") },
    async (args) => {
      try {
        const res = await httpCallback("DELETE", `${cbBase}/scheduler/tasks/${args.taskId}`, null, 10_000);
        const data = JSON.parse(res.text) as { ok?: boolean; error?: string };
        if (res.status < 200 || res.status >= 300) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };
        return { content: [{ type: "text" as const, text: `Task ${args.taskId} deleted.` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed to delete task: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );

  const schedulerUpdateTool = tool(
    "update",
    "Pause or resume a scheduled task.",
    {
      taskId: z.string().describe("Task ID to update"),
      status: z.enum(["active", "paused"]).describe("New status"),
    },
    async (args) => {
      try {
        const res = await httpCallback("PATCH", `${cbBase}/scheduler/tasks/${args.taskId}`, JSON.stringify({ status: args.status }), 10_000);
        const data = JSON.parse(res.text) as { task?: Record<string, unknown>; error?: string };
        if (res.status < 200 || res.status >= 300) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };
        return { content: [{ type: "text" as const, text: `Task ${args.taskId} is now ${args.status}.` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed to update task: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );

  const schedulerMcpServer = createSdkMcpServer({
    name: "scheduler",
    version: "1.0.0",
    tools: [schedulerCreateTool, schedulerListTool, schedulerDeleteTool, schedulerUpdateTool],
  });

  // ── Build query options ──
  const resolvedCwd = request.cwd ?? process.env.AGENT_WORKSPACE ?? process.cwd();
  const options: Record<string, unknown> = {
    model: request.model ?? DEFAULT_MODEL,
    systemPrompt: request.systemPrompt,
    maxTurns: request.maxTurns ?? DEFAULT_MAX_TURNS,
    cwd: resolvedCwd,
    // addDir: make the SDK load CLAUDE.md and skills from the agent workspace even when
    // resolvedCwd points elsewhere (e.g. platform root to avoid Mjz .claude/skills/ block).
    ...(request.addDir?.length ? { addDir: request.addDir } : {}),
    // Workers run inside a security boundary — bypass is the correct mode.
    // The PreToolUse hook below is our permission gate.
    // allowDangerouslySkipPermissions is required for bypassPermissions to fully disable
    // the SDK's secondary safety checks (e.g. Mjz() which blocks .claude/skills/ writes).
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: request.disallowedTools,
    settings: request.sdkSettings,
    mcpServers: { agent: agentMcpServer, scheduler: schedulerMcpServer },
  };

  if (request.tools) options.tools = request.tools;
  if (request.effort) options.effort = request.effort;
  // Merge request.env with process.env so the SDK subprocess (cli.js) inherits
  // HOME, PATH, and other critical vars — request.env overrides where needed.
  if (request.env) options.env = { ...process.env, ...request.env };

  // Capture SDK subprocess stderr for debugging auth failures
  options.stderr = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) console.error(`[worker] [sdk-stderr] ${trimmed}`);
  };

  if (request.sessionId && !request.forceNewSession) {
    options.resume = request.sessionId;
  }

  // ── PreToolUse hook: every tool call is checked against orchestrator RBAC ──
  // Long timeout — HITL approval can take minutes (user clicks a Discord button).
  options.hooks = {
    PreToolUse: [{
      hooks: [async (hookInput: Record<string, unknown>) => {
        try {
          const body = JSON.stringify({
            tool_name: hookInput.tool_name,
            tool_input: hookInput.tool_input ?? {},
          });
          // Use node:http directly to bypass undici/fetch proxy interference.
          // HITL approvals can take minutes, so use a 10-minute timeout.
          const res = await httpPost(`${cbBase}/pretooluse`, body, 10 * 60_000);
          if (res.status < 200 || res.status >= 300) {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: `Permission callback failed (${res.status})`,
              },
            };
          }
          return JSON.parse(res.text);
        } catch (err) {
          const cause = err instanceof Error ? (err as any).cause : undefined;
          const causeMsg = cause instanceof Error ? cause.message : (cause ? String(cause) : '');
          const causeCode = (err as any).code ?? (cause instanceof Error ? (cause as any).code : undefined);
          console.error(`[worker] PreToolUse callback error: ${err instanceof Error ? err.message : String(err)}${causeMsg ? ` | cause: ${causeMsg}` : ''}${causeCode ? ` | code: ${causeCode}` : ''} (url: ${cbBase})`);
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Permission callback unreachable",
            },
          };
        }
      }],
    }],
  };

  // ── Run the agent loop ──
  let sdkSessionId = "";
  let resultText = "";
  let stopReason = "unknown";
  let turns = 0;
  let toolStart = 0;
  let prevUsage = { input: -1, output: -1, cacheRead: -1, cacheCreate: -1 };
  let emittedStarted = false;

  try {
    for await (const message of query({ prompt: channel as any, options: options as any })) {
      const m = message as Record<string, unknown>;

      if (m.session_id) {
        sdkSessionId = String(m.session_id);
        if (!emittedStarted) {
          emit({ type: "started", sessionId: sdkSessionId });
          emittedStarted = true;
        }
      }

      if (m.type === "assistant") {
        const betaMsg = (m as any).message;
        if (betaMsg?.usage) {
          const u = betaMsg.usage;
          const cur = {
            input: Number(u.input_tokens ?? 0),
            output: Number(u.output_tokens ?? 0),
            cacheRead: Number(u.cache_read_input_tokens ?? 0),
            cacheCreate: Number(u.cache_creation_input_tokens ?? 0),
          };
          // Skip duplicate entries (SDK sometimes yields two per API call)
          if (
            cur.input === prevUsage.input &&
            cur.output === prevUsage.output &&
            cur.cacheRead === prevUsage.cacheRead &&
            cur.cacheCreate === prevUsage.cacheCreate
          ) {
            continue;
          }
          prevUsage = cur;
          turns++;
          emit({ type: "turn", turns, ...cur });
        }
        for (const block of (m as any).message?.content ?? []) {
          if (block.type === "tool_use") {
            toolStart = Date.now();
            emit({ type: "tool_start", name: block.name });
          }
        }
      } else if (m.type === "user" && toolStart) {
        emit({ type: "tool_end", name: "", elapsedMs: Date.now() - toolStart });
        toolStart = 0;
      } else if ("result" in m) {
        resultText = String((m as any).result ?? "");
        stopReason = String((m as any).stop_reason ?? "unknown");
        const modelUsage = (m as any).modelUsage;
        if (modelUsage) {
          console.log(`[worker] usage: ${formatModelUsage(modelUsage)}`);
        }
        break; // result is the terminal SDK event — exit the loop
      }
    }
  } catch (err) {
    if (isStaleSessionError(err) && request.sessionId && !request.forceNewSession) {
      console.log(`[worker] Stale session ${request.sessionId} — signalling orchestrator to retry`);
      emit({ type: "stale_session" });
      return;
    }
    throw err;
  }

  emit({ type: "result", text: resultText, sessionId: sdkSessionId, stopReason, files: pendingFiles });
}
