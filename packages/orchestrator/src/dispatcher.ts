/**
 * Unified agent dispatcher — all agents run as HTTP worker servers.
 *
 * dispatchToWorker():
 *   1. Gets (or starts) the worker via WorkerManager
 *   2. Generates a callback token and registers a SessionContext
 *   3. POSTs /sessions to the worker (with cwd, env, callback URL, RBAC token)
 *   4. SSE-subscribes to /sessions/:id/events
 *   5. Handles stale-session retry (re-posts without sessionId)
 *   6. Returns DispatchResult on terminal event
 *   7. Cleans up (DELETE session, revoke proxy token, remove session context)
 *
 * The orchestrator callback server (port 7420) handles inbound calls from workers:
 *   - PreToolUse permission checks
 *   - Agent start / stop / message (sub-agent MCP)
 */

import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  AgentConfig,
  AgentsConfig,
  AskApprovalFn,
  ChannelAttachment,
  ChannelMessage,
  DispatchResult,
  PlatformConfig,
} from "./types.js";
import type { WorkerManager } from "./workers/index.js";
import {
  createCallbackSession,
  deleteCallbackSession,
  type CallbackSession,
} from "./api/sessions.js";

// ── Worker protocol types (mirrored from packages/worker/src/types.ts) ──

interface WorkerSessionRequest {
  prompt: string;
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append: string };
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  sessionId?: string;
  forceNewSession?: boolean;
  maxTurns?: number;
  effort?: string;
  scope?: string;
  cwd?: string;
  addDir?: string[];
  env?: Record<string, string>;
  orchestratorUrl: string;
  callbackToken: string;
  sdkSettings?: Record<string, unknown>;
  redisMode?: boolean;
}

type WorkerEvent =
  | { type: "started"; sessionId: string }
  | { type: "turn"; turns: number; input: number; output: number; cacheRead: number; cacheCreate: number }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; elapsedMs: number }
  | { type: "result"; text: string; sessionId: string; stopReason: string }
  | { type: "error"; message: string }
  | { type: "stale_session" };

// ── Dispatch log ──
import { appendLog } from "./log.js";
const LOG_DIR = join(homedir(), ".stockade", "logs");
const LOG_FILE = join(LOG_DIR, "dispatch.log");
mkdirSync(LOG_DIR, { recursive: true });

function dispatchLog(message: string): void {
  console.log(message);
  appendLog(LOG_FILE, message);
}

/**
 * Context needed for agent dispatch.
 */
export interface DispatchContext {
  allAgents: AgentsConfig;
  platform: PlatformConfig;
  userId: string;
  userPlatform: string;
  agentsDir: string;
  platformRoot?: string;
  askApproval?: AskApprovalFn;
  workerManager: WorkerManager;
  proxy?: {
    gatewayUrl: string;
    host: string;
    caCertPath: string;
  };
  /** Orchestrator callback server URL (e.g., "http://localhost:7420") */
  orchestratorCallbackUrl: string;
  /** For inline sub-agents: parent agent's cwd */
  parentCwd?: string;
  /**
   * For self-spawn sub-agents: force parent cwd regardless of agentConfig.inline.
   * Unlike config-inline (which suppresses settings), self-spawns load memory and CLAUDE.md.
   */
  forceParentCwd?: boolean;
  /** runId for the current sub-agent dispatch (set by agent-mcp handler) */
  parentRunId?: string;
  /**
   * For background sub-agent completion: called when the background agent finishes.
   * Should enqueue the result as a new message for the parent scope (via dispatch queue)
   * and deliver the agent's final response back to the originating channel.
   */
  onBackgroundComplete?: (
    scope: string,
    text: string,
    meta: { userId: string; userPlatform: string; askApproval?: AskApprovalFn },
  ) => void;
  /** Whether the platform scheduler is enabled (injects scheduler instructions) */
  schedulerEnabled?: boolean;
}

/**
 * Build platform-injected instructions for the system prompt.
 */
function buildPlatformInstructions(
  agentConfig: AgentConfig,
  hasProxy: boolean,
  allAgents?: AgentsConfig,
  schedulerEnabled = false,
): string {
  const sections: string[] = [];

  // Inject sub-agent roster when this agent has a subagents list
  if (agentConfig.subagents?.length && allAgents) {
    const lines = agentConfig.subagents.map((id) => {
      const sub = allAgents.agents[id];
      if (!sub) return `- **${id}**`;
      const tag = sub.sandboxed ? "sandboxed" : sub.inline ? "inline" : "host";
      const desc = sub.description ? ` — ${sub.description}` : "";
      return `- **${id}**${desc} [${tag}]`;
    });
    lines.push(`- **self-spawn** (omit \`agentId\`) — Parallel copy of this agent in the same workspace with full memory loaded [host]`);
    sections.push(
      `## Available Sub-Agents (platform-injected)\n\nInvoke via \`mcp__agent__start\`:\n\n${lines.join("\n")}`,
    );
  }

  const proxyCredentials = (agentConfig.credentials ?? []).filter(k => k !== "claude-oauth-token");
  if (hasProxy && proxyCredentials.length) {
    sections.push(`## Credential Proxy (platform-injected)

Your outbound traffic is routed through a credential proxy. It handles API
key injection automatically — you never see raw credentials.

- **Header injection (automatic):** Outbound HTTPS requests to configured hosts
  have auth headers stripped and re-injected with the correct credential. API calls
  to Anthropic, Tavily, GitHub, etc. just work.

- **Body injection (ref tokens):** When a credential must appear in a request body,
  use the \`apw\` CLI:
  \`\`\`bash
  apw read <credential-key>
  # Returns: apw-ref:<key>:<nonce>
  \`\`\`
  Embed the ref string in your request body. The proxy substitutes it with the real
  value before forwarding. Ref tokens are one-time-use and expire after 5 minutes.

- **Your credential keys:** ${proxyCredentials.map(k => `\`${k}\``).join(", ")}

- **Available env vars:** HTTP_PROXY, HTTPS_PROXY, NO_PROXY, NODE_EXTRA_CA_CERTS,
  APW_GATEWAY, APW_TOKEN`);
  }

  if (agentConfig.sandboxed) {
    sections.push(`## Network Policy (platform-injected)

You run in a sandboxed container. Only hosts in the proxy's network policy allowlist
are reachable. If a request is blocked, ask the parent agent if access is needed.`);
  }

  // Always inject shared directory path (differs by sandboxing)
  {
    const sharedPath = agentConfig.sandboxed ? "`/shared`" : "`$SHARED_DIR` (`~/.stockade/shared/`)";
    sections.push(`## Shared Directory (platform-injected)

A shared read-write directory is available for file exchange and cross-agent persistence.

Path: ${sharedPath}

Use it to pass files between agents, persist build outputs or reports across sessions, and stage files before moving them. Do not store secrets or credentials here.`);
  }

  if (schedulerEnabled) {
    sections.push(`## Scheduler (platform-injected)

You can manage scheduled tasks that run prompts automatically on a recurring or one-shot basis.
Results are delivered back to the channel where the task was created.

Tools:
- \`mcp__scheduler__list\` — list all scheduled tasks (id, prompt, schedule, status, next_run)
- \`mcp__scheduler__create\` — create a task. Params: \`prompt\`, \`schedule_type\` (interval|cron|once), \`schedule_value\` (ms for interval, cron expression, or ISO datetime), \`context_mode\` (optional, default: isolated)
- \`mcp__scheduler__update\` — pause or resume a task. Params: \`taskId\`, \`status\` (active|paused)
- \`mcp__scheduler__delete\` — permanently delete a task. Params: \`taskId\`

Schedule types:
- \`interval\`: repeat every N milliseconds (e.g. \`120000\` = every 2 min)
- \`cron\`: cron expression (e.g. \`0 9 * * *\` = daily at 9 AM)
- \`once\`: ISO datetime for a one-shot run (e.g. \`2026-04-06T09:00:00Z\`)`);
  }

  return sections.join("\n\n");
}

/**
 * Build the system prompt for an agent.
 *
 * - "replace" mode (default): returns a plain string
 * - "append" mode: returns a SDK preset object that keeps the Claude Code prompt
 *
 * Use config-based hasProxy (not runtime token check) so the prompt is stable
 * across dispatches — a flaky proxy timeout must not change the cache prefix.
 */
export function buildSystemPrompt(
  agentConfig: AgentConfig,
  hasProxy = false,
  allAgents?: AgentsConfig,
  schedulerEnabled = false,
): string | { type: "preset"; preset: "claude_code"; append: string } | undefined {
  const platform = buildPlatformInstructions(agentConfig, hasProxy, allAgents, schedulerEnabled);
  const user = agentConfig.system;
  const combined = [user, platform].filter(Boolean).join("\n\n");
  if (!combined) return undefined;

  const mode = agentConfig.system_mode ?? "replace";
  if (mode === "append") {
    return { type: "preset" as const, preset: "claude_code" as const, append: combined };
  }
  return combined;
}

/**
 * Tools that must never be available to agents.
 * The "Agent" tool is replaced by our mcp__agent__* suite.
 */
export const PLATFORM_DISALLOWED_TOOLS = [
  "Agent",
  "WebSearch",
  "CronCreate",
  "CronDelete",
  "CronList",
  "NotebookEdit",
  "SendMessage",
  "TeamDelete",
  "AskUserQuestion",
];

/**
 * Deny rules that prevent agents from modifying their own configuration.
 */
export const SELF_MODIFICATION_DENY_RULES = [
  "Write(.claude/settings*)",
  "Write(.claude/agents/**)",
  "Write(.claude/mcp*)",
  "Write(.claude/rules/**)",
  "Edit(.claude/settings*)",
  "Edit(.claude/agents/**)",
  "Edit(.claude/mcp*)",
  "Edit(.claude/rules/**)",
];

/**
 * Extract Skill allow/deny selectors from an agent's permission rules.
 *
 * These are passed natively to the SDK so it filters skill descriptions from
 * the agent's context window — denied skills don't appear at all (0 tokens),
 * not just blocked at invocation time via PreToolUse.
 */
function extractSkillPermissions(rules: string[] | undefined): {
  allow: string[];
  deny: string[];
} {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const rule of rules ?? []) {
    const colonIdx = rule.indexOf(":");
    if (colonIdx === -1) continue;
    const action = rule.slice(0, colonIdx);
    const selector = rule.slice(colonIdx + 1);
    if (!selector.startsWith("Skill")) continue;
    if (action === "allow") allow.push(selector);
    else if (action === "deny") deny.push(selector);
  }
  return { allow, deny };
}

/**
 * Build SDK settings object for an agent.
 *
 * @param agentConfig  Agent configuration
 * @param agentId      Agent ID (for logs)
 * @param memoryDir    Resolved memory directory as seen inside the worker
 */
export function buildSdkSettings(
  agentConfig: AgentConfig,
  agentId: string,
  memoryDir?: string,
  inline = false,
): Record<string, unknown> {
  const memoryEnabled = !inline && (agentConfig.memory?.enabled ?? true);

  // Extract Skill rules from agent permissions and pass to the SDK natively.
  // The SDK uses these to filter skill descriptions from context (hiding skills
  // entirely — 0 tokens — rather than just blocking invocation via PreToolUse).
  const { allow: skillAllow, deny: skillDeny } = extractSkillPermissions(agentConfig.permissions);

  return {
    autoMemoryEnabled: memoryEnabled,
    ...(memoryEnabled && memoryDir ? { autoMemoryDirectory: memoryDir } : {}),
    autoDreamEnabled: !inline && (agentConfig.memory?.autoDream ?? false),
    // Inline agents share a parent's workspace but must not load that workspace's
    // project config (CLAUDE.md, settings, skills) — they're programmatically defined.
    // Non-inline agents load only project-level settings (no user-global bleed).
    settingSources: inline ? [] : ["project"],
    permissions: {
      ...(skillAllow.length ? { allow: skillAllow } : {}),
      deny: [
        "Agent",
        ...SELF_MODIFICATION_DENY_RULES,
        ...skillDeny,
      ],
    },
  };
}

/** Image MIME types accepted by the Anthropic API for inline content blocks. */
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Save attachments to the agent's host workspace.
 * Returns host paths. Caller converts to container paths if needed.
 */
export function saveAttachmentsToDisk(attachments: ChannelAttachment[], agentCwd: string): string[] {
  const ts = Date.now();
  const dir = join(agentCwd, "tmp", "attachments", String(ts));
  mkdirSync(dir, { recursive: true });

  return attachments.map((att) => {
    const safeName = att.filename.replace(/[/\\]/g, "_");
    const filePath = join(dir, safeName);
    writeFileSync(filePath, Buffer.from(att.data, "base64"));
    return filePath;
  });
}

/**
 * Build a prompt string that references saved attachment files.
 * All files are saved to disk; text is extended with a file listing.
 */
export function buildPromptWithAttachments(
  text: string,
  attachments: ChannelAttachment[],
  savedPaths: string[],
): string {
  const fileLines = savedPaths.map(
    (p, i) => `- ${p} (${attachments[i].contentType}, ${attachments[i].size} bytes)`,
  );
  if (fileLines.length === 0) return text;
  return (
    text +
    `\n\nAttached files saved to your workspace:\n${fileLines.join("\n")}\n\n` +
    `You can read, analyze, or process these files using your tools (Read, Bash, etc.).`
  );
}

// ── SSE stream reader ──

/**
 * Subscribe to a worker's SSE event stream and return the first terminal event.
 * Logs intermediate events (turn, tool_start, tool_end) as they arrive.
 */
async function subscribeToEvents(
  workerUrl: string,
  workerSessionId: string,
  agentId: string,
  timeoutMs: number,
): Promise<WorkerEvent & { type: "result" | "error" | "stale_session" }> {
  const res = await fetch(`${workerUrl}/sessions/${workerSessionId}/events`, {
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok || !res.body) {
    throw new Error(`SSE connection failed: ${res.status}`);
  }

  const reader = (res.body as any).getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = "";
  let turns = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6)) as WorkerEvent;

        if (event.type === "turn") {
          turns++;
          const parts = [`${event.input}in/${event.output}out`];
          if (event.cacheRead > 0) parts.push(`cache_read:${event.cacheRead}`);
          if (event.cacheCreate > 0) parts.push(`cache_create:${event.cacheCreate}`);
          dispatchLog(`[dispatch] ${agentId} turn ${turns}: ${parts.join(" ")}`);
        } else if (event.type === "tool_start") {
          dispatchLog(`[dispatch] ${agentId} tool: ${event.name}`);
        } else if (event.type === "tool_end") {
          dispatchLog(`[dispatch] ${agentId} tool done: ${event.elapsedMs}ms`);
        }

        if (event.type === "result" || event.type === "error" || event.type === "stale_session") {
          return event as WorkerEvent & { type: "result" | "error" | "stale_session" };
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  throw new Error("SSE stream ended without terminal event");
}

// ── Sub-agent session cache (persists within process) ──
const subagentSessions = new Map<string, string>();

/**
 * Dispatch a message to an agent via its worker.
 *
 * This is the single dispatch path — all agents go through workers.
 * For sandboxed agents, the WorkerManager starts/manages Docker containers.
 * For host agents, the WorkerManager manages child processes.
 */
export async function dispatchToWorker(
  agentId: string,
  message: ChannelMessage,
  agentConfig: AgentConfig,
  sessionId: string | null,
  context: DispatchContext,
  permissionHook?: (tool: string, input: Record<string, unknown>) => Promise<unknown>,
): Promise<DispatchResult> {
  void permissionHook; // unused — RBAC goes through the HTTP callback now

  const dispatchStart = Date.now();
  const preview = message.content.slice(0, 80).replace(/\n/g, " ");
  dispatchLog(`[dispatch] → ${agentId} | user=${context.userId} scope=${message.scope.slice(0, 40)} | "${preview}${message.content.length > 80 ? "…" : ""}"`);

  // Determine agent cwd (inline agents share parent workspace)
  // forceParentCwd = self-spawn: uses parent cwd but still loads settings/memory
  const isInline = (agentConfig.inline || context.forceParentCwd) && context.parentCwd;
  const hostAgentCwd = isInline
    ? context.parentCwd!
    : resolve(context.agentsDir, agentId);

  // cwd as seen inside the worker (Docker: /workspace, host: absolute path)
  const workerCwd = agentConfig.sandboxed ? "/workspace" : hostAgentCwd;

  // sdkCwd: the cwd passed to the Claude SDK's query() call.
  // For host agents, we set this to the platform root rather than the agent workspace.
  // Rationale: the SDK's Mjz() safety check blocks writes to {cwd}/.claude/skills/**,
  // which prevents MadgeBot from editing its own skill files. By setting sdkCwd to the
  // platform root (which has no .claude/skills/), Mjz() won't match the agent workspace
  // skills path. The actual agent workspace is added as addDir so CLAUDE.md and skills
  // still load correctly. The permission context (agentCwd) stays as the agent workspace.
  const platformRoot = context.platformRoot ?? join(homedir(), ".stockade");
  const sdkCwd = agentConfig.sandboxed ? workerCwd : platformRoot;
  const sdkAddDirs = agentConfig.sandboxed ? [] : [hostAgentCwd];

  // ── Step 1: Ensure the worker is running ──
  const workerUrl = await context.workerManager.ensure(agentId, agentConfig, message.scope);

  // ── Step 2: Build callback token & register session ──
  const callbackToken = randomUUID();
  const sessionCtx: CallbackSession = {
    callbackToken,
    agentId,
    scope: message.scope,
    userId: context.userId,
    userPlatform: context.userPlatform,
    agentConfig,
    agentCwd: workerCwd,
    platformRoot,
    askApproval: context.askApproval,
    platformConfig: context.platform,
    allAgents: context.allAgents,
    agentsDir: context.agentsDir,
    workerUrl,
  };
  createCallbackSession(callbackToken, sessionCtx);

  // ── Step 3: Fetch proxy token & build env (if applicable) ──
  let proxyToken: string | undefined;
  let workerEnv: Record<string, string> | undefined;

  if (context.proxy) {
    const sid = sessionId ?? "";
    // Route through the MITM proxy for cache marker injection and audit logging.
    // The proxy does NOT handle Anthropic API auth — the SDK manages its own OAuth
    // token refresh via platform.claude.com (in NO_PROXY, bypasses MITM).
    // The proxy only injects credentials for 3rd-party routes (GitHub, Tavily, etc).
    const caCertPath = agentConfig.sandboxed ? "/certs/proxy-ca.crt" : context.proxy.caCertPath;
    workerEnv = {
      HTTP_PROXY: `http://${context.proxy.host}:10255`,
      HTTPS_PROXY: `http://${context.proxy.host}:10255`,
      NO_PROXY: "localhost,127.0.0.1,host.docker.internal,platform.claude.com,console.anthropic.com",
      NODE_EXTRA_CA_CERTS: caCertPath,
      CURL_CA_BUNDLE: caCertPath,
      REQUESTS_CA_BUNDLE: caCertPath,
      SSL_CERT_FILE: caCertPath,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      PYTHONIOENCODING: "utf-8",
      // Stockade context headers — injected via Claude Code's custom-headers
      // mechanism so the proxy can tag each API call with session/agent/scope.
      // The proxy strips these before forwarding to Anthropic.
      ANTHROPIC_CUSTOM_HEADERS: [
        `X-Stockade-Session: ${sid}`,
        `X-Stockade-Agent: ${agentId}`,
        `X-Stockade-Scope: ${message.scope ?? ""}`,
      ].join("\n"),
    };

    if (agentConfig.credentials?.length) {
      try {
        const tokenRes = await fetch(`${context.proxy.gatewayUrl}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(3_000),
          body: JSON.stringify({
            agentId,
            credentials: agentConfig.credentials,
            storeKeys: agentConfig.store_keys,
          }),
        });
        if (tokenRes.ok) {
          const data = (await tokenRes.json()) as { token: string };
          proxyToken = data.token;
          workerEnv.APW_GATEWAY = context.proxy.gatewayUrl;
          workerEnv.APW_TOKEN = data.token;

          // Resolve credential env vars for CLI tools (e.g. tavily)
          const credentialEnvMap: Record<string, string> = {
            "tavily-api-key": "TAVILY_API_KEY",
          };
          for (const credKey of agentConfig.credentials) {
            const envVar = credentialEnvMap[credKey];
            if (envVar && !workerEnv[envVar]) {
              try {
                const refRes = await fetch(`${context.proxy.gatewayUrl}/gateway/reveal/${credKey}`, {
                  headers: { Authorization: `Bearer ${data.token}` },
                  signal: AbortSignal.timeout(5_000),
                });
                if (refRes.ok) {
                  const refData = (await refRes.json()) as { value: string };
                  workerEnv[envVar] = refData.value;
                }
              } catch { /* non-fatal */ }
            }
          }
        }
      } catch { /* proxy not running — continue without credential injection */ }
    }
  }

  // Disable 1M context models and adaptive thinking for all agent sessions.
  workerEnv = {
    ...workerEnv,
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
    MAX_THINKING_TOKENS: agentConfig.model?.includes("opus") ? "128000" : "64000",
  };

  // For inline agents, override AGENT_WORKSPACE so the persistent worker's
  // default workspace env doesn't bleed into the SDK subprocess.
  if (isInline) {
    workerEnv = { ...workerEnv, AGENT_WORKSPACE: hostAgentCwd };
  }

  // ── Step 4: Build system prompt and SDK settings ──
  const hasProxyConfig = !!(context.proxy && agentConfig.credentials?.length);
  const systemPrompt = buildSystemPrompt(agentConfig, hasProxyConfig, context.allAgents, context.schedulerEnabled);
  const memoryDir = context.workerManager.resolveMemoryPath(agentId, agentConfig);
  // Config-inline suppresses settings (settingSources: []); self-spawn loads them normally.
  // agentConfig.inline && !!isInline → true only for config-inline, not self-spawn.
  const sdkSettings = buildSdkSettings(agentConfig, agentId, memoryDir, agentConfig.inline && !!isInline);

  // ── Step 5: Build prompt string (save attachments if any) ──
  let promptText = message.content;
  if (message.attachments?.length) {
    const savedPaths = saveAttachmentsToDisk(message.attachments, hostAgentCwd);
    // For Docker workers, convert host paths to container paths
    const promptPaths = agentConfig.sandboxed
      ? savedPaths.map((p) => p.replace(hostAgentCwd, "/workspace").replace(/\\/g, "/"))
      : savedPaths;
    promptText = buildPromptWithAttachments(message.content, message.attachments, promptPaths);
  }

  // ── Step 6: POST /sessions to worker ──
  const sessionReq: WorkerSessionRequest = {
    prompt: promptText,
    systemPrompt,
    tools: agentConfig.tools?.filter((t) => t !== "Agent"),
    disallowedTools: [
      ...PLATFORM_DISALLOWED_TOOLS,
      ...(agentConfig.disallowed_tools ?? []),
    ],
    model: agentConfig.model,
    sessionId: sessionId ?? undefined,
    maxTurns: agentConfig.max_turns ?? 200,
    effort: agentConfig.effort,
    scope: message.scope,
    cwd: sdkCwd,
    addDir: sdkAddDirs.length ? sdkAddDirs : undefined,
    env: workerEnv,
    // Sandboxed agents run in Docker containers: localhost resolves to the container
    // itself, not the host. Use host.docker.internal so the container can reach back.
    orchestratorUrl: agentConfig.sandboxed
      ? context.orchestratorCallbackUrl.replace("localhost", "host.docker.internal")
      : context.orchestratorCallbackUrl,
    callbackToken,
    sdkSettings,
  };

  const timeoutMs = agentConfig.timeout_ms ?? 3_600_000;

  const doDispatch = async (req: WorkerSessionRequest): Promise<DispatchResult> => {
    let sessRes: Response;
    try {
      sessRes = await fetch(`${workerUrl}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new Error(`Failed to create worker session: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!sessRes.ok) {
      throw new Error(`Worker returned ${sessRes.status}: ${await sessRes.text()}`);
    }

    const { workerSessionId } = await sessRes.json() as { workerSessionId: string };

    // Update session context with worker session ID (for inject / background completion)
    sessionCtx.workerSessionId = workerSessionId;

    // Register the session ID with the parent run (for agent-mcp stop/message)
    if (context.parentRunId) {
      const { registerRunSession } = await import("./agent-mcp.js");
      registerRunSession(context.parentRunId, workerUrl, workerSessionId);
    }

    // ── Step 7: Subscribe to SSE and wait for terminal event ──
    const terminal = await subscribeToEvents(workerUrl, workerSessionId, agentId, timeoutMs);

    // Cleanup worker session
    fetch(`${workerUrl}/sessions/${workerSessionId}`, { method: "DELETE" }).catch(() => {});

    if (terminal.type === "stale_session") {
      return null as unknown as DispatchResult; // signal stale
    }
    if (terminal.type === "error") {
      throw new Error(terminal.message);
    }

    // terminal.type === "result"
    const elapsed = ((Date.now() - dispatchStart) / 1000).toFixed(1);
    const resultPreview = terminal.text.slice(0, 100).replace(/\n/g, " ");
    dispatchLog(`[dispatch] ← ${agentId} | ${elapsed}s | session=${terminal.sessionId.slice(0, 12)} | "${resultPreview}${terminal.text.length > 100 ? "…" : ""}"`);

    return { result: terminal.text, sessionId: terminal.sessionId };
  };

  try {
    let result = await doDispatch(sessionReq);

    // Stale session recovery — retry without resume
    if (result === null) {
      console.log(`[dispatch] Stale session for ${agentId} — retrying fresh`);
      result = await doDispatch({ ...sessionReq, sessionId: undefined, forceNewSession: true });
    }

    return result;
  } finally {
    deleteCallbackSession(callbackToken);
    if (proxyToken && context.proxy) {
      fetch(`${context.proxy.gatewayUrl}/token/${proxyToken}`, { method: "DELETE" }).catch(() => {});
    }
  }
}

/**
 * Top-level dispatch entry point — wraps dispatchToWorker with sub-agent session caching.
 * Used by the orchestrator's message handler and scheduler.
 */
export async function dispatch(
  agentId: string,
  message: ChannelMessage,
  agentConfig: AgentConfig,
  sessionId: string | null,
  permissionHook: ((tool: string, input: Record<string, unknown>) => Promise<unknown>) | undefined,
  context: DispatchContext,
): Promise<DispatchResult> {
  return dispatchToWorker(agentId, message, agentConfig, sessionId, context, permissionHook);
}
