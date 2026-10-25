/**
 * Orchestrator callback server — listens on port 7420.
 *
 * Workers call back here for:
 *   POST /cb/:token/pretooluse   — RBAC permission check (may block for HITL)
 *   POST /cb/:token/agent/start  — start a sub-agent (blocking or background)
 *   POST /cb/:token/agent/stop   — abort a sub-agent
 *   POST /cb/:token/agent/message — inject a message into a running sub-agent
 *
 *   GET    /cb/:token/scheduler/tasks       — list scheduled tasks
 *   POST   /cb/:token/scheduler/tasks       — create a scheduled task
 *   PATCH  /cb/:token/scheduler/tasks/:id   — pause / resume a task
 *   DELETE /cb/:token/scheduler/tasks/:id   — delete a task
 *
 *   POST /cb/:token/sessions/list|search|read — past-session history, bounded
 *                                               by the calling user's permissions
 *   POST /cb/:token/peers/list|send           — session-to-session messaging (peers.ts)
 *
 *   /controller/*                              — controller API for the app (api/controller-routes.ts)
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { CronExpressionParser } from "cron-parser";
import { getCallbackSession } from "./sessions.js";
import type { AskQuestion } from "../types.js";
import { buildPreToolUseHook } from "../rbac.js";
import { resolveEffectivePermissions } from "../gatekeeper.js";
import { runHostCommand } from "../host-bash.js";
import {
  handleAgentStart,
  handleAgentStop,
  handleAgentMessage,
} from "../agent-mcp.js";
import type { WorkerManager } from "../workers/index.js";
import type { DispatchContext } from "../dispatcher.js";
import type { OrchestratorBridge } from "../bus/orchestrator-bridge.js";
import type { TaskStore, ScheduleType, ContextMode } from "../scheduler/types.js";
import type { ChannelFile } from "../types.js";
import type { SessionHistoryService } from "../session-history.js";
import { canUsePeers, type PeerService } from "../peers.js";

export const CALLBACK_PORT = 7420;

export function startCallbackServer(
  workerManager: WorkerManager,
  bridge: OrchestratorBridge | null,
  buildDispatchContext: (token: string) => DispatchContext | null,
  taskStore?: TaskStore,
  sendToChannel?: (scope: string, text: string, files?: ChannelFile[]) => Promise<void>,
  sessionHistory?: SessionHistoryService,
  peers?: PeerService,
  /** A dispatch into a named scope: record its acting person as a participant (platform "api"). */
  noteDispatch?: (scope: string, userId: string, userPlatform: string) => void,
  /** Extra routes on the same server (the controller API). */
  mountRoutes?: (app: Hono) => void,
): () => void {
  const app = new Hono();

  // ── PreToolUse permission check ──
  app.post("/cb/:token/pretooluse", async (c) => {
    const token = c.req.param("token");
    const ctx = getCallbackSession(token);
    if (!ctx) {
      return c.json({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Unknown callback token",
        },
      });
    }

    const { tool_name, tool_input } = await c.req.json() as {
      tool_name: string;
      tool_input: Record<string, unknown>;
    };

    const agentRules = resolveEffectivePermissions(
      ctx.agentConfig.permissions,
      ctx.platformConfig.gatekeeper,
    );

    // Agents in an SDK permission mode of their own (auto): the hook only denies.
    const mode = ctx.agentConfig.permission_mode ?? "bypassPermissions";
    const hook = buildPreToolUseHook(
      ctx.userId,
      ctx.userPlatform,
      ctx.platformConfig,
      agentRules,
      ctx.agentCwd,
      ctx.platformRoot,
      ctx.askApproval,
      ctx.agentId,
      mode !== "bypassPermissions",
    );

    const result = await hook({ tool_name, tool_input });
    const decision = result.hookSpecificOutput.permissionDecision ?? `defer(${mode})`;
    console.log(`[pretooluse] ${decision} "${tool_name}" (${ctx.agentId})`);
    return c.json(result);
  });

  // ── canUseTool: the SDK's permission mode asks for a human ──
  // (auto mode falling back to prompting, protected paths, …). Posts the
  // channel's Approve/Deny buttons; no channel (scheduler, API) means deny.
  app.post("/cb/:token/canusetool", async (c) => {
    const ctx = getCallbackSession(c.req.param("token"));
    if (!ctx) return c.json({ approved: false, reason: "Unknown callback token" });
    const { tool_name, tool_input } = await c.req.json() as {
      tool_name: string;
      tool_input: Record<string, unknown>;
    };
    // AskUserQuestion: ask in the channel and hand the answers back as the tool's input.
    if (tool_name === "AskUserQuestion") {
      const questions = (tool_input?.questions ?? []) as AskQuestion[];
      if (!ctx.askQuestions || !Array.isArray(questions) || questions.length === 0) {
        return c.json({ approved: false, reason: "Can't ask questions here (no chat channel for this run). Decide yourself or say what you need in your reply." });
      }
      const answers = await ctx.askQuestions(questions, ctx.agentId);
      console.log(`[canusetool] AskUserQuestion (${ctx.agentId}): ${answers ? "answered" : "no answer"}`);
      if (!answers) return c.json({ approved: false, reason: "Nobody answered in time." });
      return c.json({ approved: true, updatedInput: { ...tool_input, answers } });
    }
    if (!ctx.askApproval) {
      console.log(`[canusetool] deny "${tool_name}" (${ctx.agentId}): nobody to ask`);
      return c.json({ approved: false, reason: "Needs human approval, but nobody can be asked here (scheduled or API run)" });
    }
    const approved = await ctx.askApproval(tool_name, tool_input ?? {}, ctx.agentId);
    console.log(`[canusetool] ${approved ? "approved" : "denied"} "${tool_name}" (${ctx.agentId})`);
    return c.json({ approved, ...(approved ? {} : { reason: "Denied by approver (or timed out)" }) });
  });

  // ── Host bash: run a whitelisted command on the host machine ──
  // The worker's mcp__host__bash MCP tool POSTs here. We re-evaluate the
  // Bash:host permission rule (defense in depth — the PreToolUse hook in
  // the SDK is the primary gate, but workers are across a trust boundary).
  app.post("/cb/:token/host-bash", async (c) => {
    const token = c.req.param("token");
    const ctx = getCallbackSession(token);
    if (!ctx) return c.json({ error: "Unknown callback token" }, 404);
    // Host commands run as the platform user: never for run-as agents.
    if (ctx.agentConfig.host_user) return c.json({ error: "Host commands are disabled for this agent" }, 403);

    const { command, cwd, timeoutMs } = await c.req.json() as {
      command: string;
      cwd?: string;
      timeoutMs?: number;
    };

    if (!command || typeof command !== "string") {
      return c.json({ error: "command is required" }, 400);
    }

    const agentRules = resolveEffectivePermissions(
      ctx.agentConfig.permissions,
      ctx.platformConfig.gatekeeper,
    );
    const hook = buildPreToolUseHook(
      ctx.userId,
      ctx.userPlatform,
      ctx.platformConfig,
      agentRules,
      ctx.agentCwd,
      ctx.platformRoot,
      ctx.askApproval,
      ctx.agentId,
    );
    const decision = await hook({ tool_name: "mcp__host__bash", tool_input: { command } });
    if (decision.hookSpecificOutput.permissionDecision !== "allow") {
      return c.json({
        error: "Host command denied",
        reason: decision.hookSpecificOutput.permissionDecisionReason ?? "policy",
      }, 403);
    }

    const result = await runHostCommand(command, { cwd, timeoutMs });
    return c.json(result);
  });

  // ── Agent tool: start ──
  app.post("/cb/:token/agent/start", async (c) => {
    const token = c.req.param("token");
    const ctx = getCallbackSession(token);
    if (!ctx) return c.json({ error: "Unknown callback token" }, 404);

    const dispatchCtx = buildDispatchContext(token);
    if (!dispatchCtx) return c.json({ error: "Dispatch context unavailable" }, 500);

    const args = await c.req.json() as {
      agentId: string;
      task: string;
      name?: string;
      background?: boolean;
      inline?: boolean;
    };

    if (!bridge) return c.json({ error: "Redis bridge not initialized" }, 503);
    try {
      const result = await handleAgentStart(args, ctx, dispatchCtx, workerManager, bridge, sendToChannel);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  // ── Agent tool: stop ──
  app.post("/cb/:token/agent/stop", async (c) => {
    const token = c.req.param("token");
    const ctx = getCallbackSession(token);
    if (!ctx) return c.json({ error: "Unknown callback token" }, 404);
    if (!bridge) return c.json({ error: "Redis bridge not initialized" }, 503);

    const { runId } = await c.req.json() as { runId: string };
    await handleAgentStop(runId, bridge);
    return c.json({ ok: true });
  });

  // ── Agent tool: message ──
  app.post("/cb/:token/agent/message", async (c) => {
    const token = c.req.param("token");
    const ctx = getCallbackSession(token);
    if (!ctx) return c.json({ error: "Unknown callback token" }, 404);
    if (!bridge) return c.json({ error: "Redis bridge not initialized" }, 503);

    const { target, text } = await c.req.json() as { target: string; text: string };
    const ok = await handleAgentMessage(target, text, bridge);
    if (!ok) return c.json({ error: `No active agent: ${target}` }, 404);
    return c.json({ ok: true });
  });

  // ── Scheduler: list tasks ──
  app.get("/cb/:token/scheduler/tasks", (c) => {
    const token = c.req.param("token");
    const ctx = getCallbackSession(token);
    if (!ctx) return c.json({ error: "Unknown callback token" }, 404);
    if (!taskStore) return c.json({ error: "Scheduler not enabled" }, 503);

    const tasks = taskStore.getAllTasks();
    return c.json({ tasks });
  });

  // ── Scheduler: create task ──
  app.post("/cb/:token/scheduler/tasks", async (c) => {
    const token = c.req.param("token");
    const ctx = getCallbackSession(token);
    if (!ctx) return c.json({ error: "Unknown callback token" }, 404);
    if (!taskStore) return c.json({ error: "Scheduler not enabled" }, 503);

    const body = await c.req.json() as {
      agentId?: string;
      prompt: string;
      schedule_type: ScheduleType;
      schedule_value: string;
      context_mode?: ContextMode;
      timezone?: string;
    };

    if (!body.prompt || !body.schedule_type || !body.schedule_value) {
      return c.json({ error: "prompt, schedule_type, and schedule_value are required" }, 400);
    }

    const timezone = body.timezone ?? ctx.platformConfig.scheduler?.timezone ?? "UTC";

    let next_run: string | null;
    try {
      next_run = computeInitialNextRun(body.schedule_type, body.schedule_value, timezone);
    } catch (err) {
      return c.json({ error: `Invalid schedule_value: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

    const task = {
      id: randomUUID(),
      agentId: body.agentId ?? ctx.agentId,
      scope: ctx.scope,
      userId: ctx.userId,
      userPlatform: ctx.userPlatform,
      prompt: body.prompt,
      schedule_type: body.schedule_type,
      schedule_value: body.schedule_value,
      context_mode: body.context_mode ?? "isolated",
      next_run,
      status: "active" as const,
      created_at: new Date().toISOString(),
    };

    taskStore.createTask(task);
    return c.json({ task }, 201);
  });

  // ── Scheduler: pause / resume task ──
  app.patch("/cb/:token/scheduler/tasks/:id", async (c) => {
    const token = c.req.param("token");
    const ctx = getCallbackSession(token);
    if (!ctx) return c.json({ error: "Unknown callback token" }, 404);
    if (!taskStore) return c.json({ error: "Scheduler not enabled" }, 503);

    const id = c.req.param("id");
    const task = taskStore.getTaskById(id);
    if (!task) return c.json({ error: "Task not found" }, 404);

    const { status } = await c.req.json() as { status: "active" | "paused" };
    if (status !== "active" && status !== "paused") {
      return c.json({ error: "status must be 'active' or 'paused'" }, 400);
    }

    taskStore.updateTask(id, { status });
    return c.json({ task: taskStore.getTaskById(id) });
  });

  // ── Scheduler: delete task ──
  app.delete("/cb/:token/scheduler/tasks/:id", (c) => {
    const token = c.req.param("token");
    const ctx = getCallbackSession(token);
    if (!ctx) return c.json({ error: "Unknown callback token" }, 404);
    if (!taskStore) return c.json({ error: "Scheduler not enabled" }, 503);

    const id = c.req.param("id");
    const task = taskStore.getTaskById(id);
    if (!task) return c.json({ error: "Task not found" }, 404);

    taskStore.deleteTask(id);
    return c.json({ ok: true });
  });

  // ── Session history: list / search / read past sessions ──
  for (const op of ["list", "search", "read"] as const) {
    app.post(`/cb/:token/sessions/${op}`, async (c) => {
      const token = c.req.param("token");
      const ctx = getCallbackSession(token);
      if (!ctx) return c.json({ error: "Unknown callback token" }, 404);
      if (!sessionHistory) return c.json({ error: "Session history not enabled" }, 503);

      const args = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      const caller = { agentId: ctx.agentId, userId: ctx.userId, userPlatform: ctx.userPlatform, scope: ctx.scope };
      try {
        const text = await sessionHistory[op](caller, args as never);
        return c.json({ text });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    });
  }

  // ── Peers: list / send ──
  // The caller is the person the session's current turn runs for, fixed at turn start.
  for (const op of ["list", "send"] as const) {
    app.post(`/cb/:token/peers/${op}`, async (c) => {
      const ctx = getCallbackSession(c.req.param("token"));
      if (!ctx) return c.json({ error: "Unknown callback token" }, 404);
      if (!peers || !canUsePeers(ctx.scope)) return c.json({ error: "Peers aren't available in this session" }, 403);
      const caller = { scope: ctx.scope, agentId: ctx.agentId, userId: ctx.userId, userPlatform: ctx.userPlatform, hops: ctx.hops ?? 0 };
      const args = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      try {
        const text = op === "list" ? await peers.listTool(caller) : await peers.sendTool(caller, args.to, args.message);
        console.log(`[peers] ${op} from ${ctx.scope.slice(0, 40)}: ${text.split("\n")[0].slice(0, 100)}`);
        return c.json({ text });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    });
  }

  // ── Direct dispatch (testing / scripting) ──
  // Acts as any user, so it needs STOCKADE_API_TOKEN (disabled without one).
  const apiToken = process.env.STOCKADE_API_TOKEN;
  app.post("/dispatch", async (c) => {
    if (!bridge) return c.json({ error: "Redis bridge not initialized" }, 503);
    const got = Buffer.from(c.req.header("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${apiToken ?? ""}`);
    if (!apiToken || got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const { agentId, prompt, scope: reqScope, userId, userPlatform, deliver, sudo } = await c.req.json() as {
      agentId: string;
      prompt: string;
      scope?: string;
      userId?: string;
      userPlatform?: string;
      deliver?: boolean;
      /** Run as the agent's sudo user (the API token is root-equivalent anyway). */
      sudo?: boolean;
    };

    if (!agentId || !prompt || !userId) {
      return c.json({ error: "agentId, prompt and userId are required" }, 400);
    }

    const scope = reqScope ?? `api:${agentId}:${randomUUID()}`;
    // Throwaway api:<agent>:<uuid> runs aren't conversations: only named scopes are recorded.
    if (reqScope) noteDispatch?.(scope, userId, userPlatform ?? "terminal");

    const result = await bridge.sendAndWait(scope, prompt, {
      agentId,
      userId,
      userPlatform: userPlatform ?? "terminal",
      sudo: !!sudo,
      noSession: !reqScope, // fresh session unless caller provides a scope to reuse
      ephemeral: !reqScope, // and don't persist throwaway no-scope api:<uuid> sessions
    });

    // Optionally deliver the reply to the originating channel (same path the
    // scheduler uses). Lets a scripted trigger post into the real Discord
    // thread instead of only returning over HTTP. Requires a real channel scope.
    let delivered = false;
    if (deliver && reqScope && sendToChannel && result?.text) {
      try {
        await sendToChannel(reqScope, result.text, result.files);
        delivered = true;
      } catch (err) {
        console.error(`[dispatch] channel delivery failed for ${reqScope.slice(0, 40)}:`, err instanceof Error ? err.message : err);
      }
    }

    return c.json({ result, scope, delivered });
  });

  mountRoutes?.(app);

  // Loopback only. Containers still reach it via host.docker.internal, which
  // Docker Desktop forwards to the host's loopback.
  const server = serve({ fetch: app.fetch, port: CALLBACK_PORT, hostname: "127.0.0.1" }, () => {
    console.log(`[callback] Orchestrator callback server on 127.0.0.1:${CALLBACK_PORT}`);
  });

  return () => {
    server.close();
  };
}

// ── Helpers ──

/**
 * Compute the first next_run for a new task.
 *
 * - cron:     next occurrence after now
 * - interval: now + interval_ms
 * - once:     schedule_value is the ISO datetime itself
 */
function computeInitialNextRun(
  scheduleType: ScheduleType,
  scheduleValue: string,
  timezone: string,
): string | null {
  if (scheduleType === "once") {
    const d = new Date(scheduleValue);
    if (isNaN(d.getTime())) throw new Error(`"${scheduleValue}" is not a valid ISO datetime`);
    return d.toISOString();
  }
  if (scheduleType === "cron") {
    const interval = CronExpressionParser.parse(scheduleValue, { tz: timezone });
    return interval.next().toISOString();
  }
  if (scheduleType === "interval") {
    const ms = parseInt(scheduleValue, 10);
    if (!ms || ms <= 0) throw new Error(`interval must be a positive number of milliseconds`);
    return new Date(Date.now() + ms).toISOString();
  }
  return null;
}
