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
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { CronExpressionParser } from "cron-parser";
import { getCallbackSession } from "./sessions.js";
import { buildPreToolUseHook } from "../rbac.js";
import { resolveEffectivePermissions } from "../gatekeeper.js";
import {
  handleAgentStart,
  handleAgentStop,
  handleAgentMessage,
} from "../agent-mcp.js";
import type { WorkerManager } from "../workers/index.js";
import type { DispatchContext } from "../dispatcher.js";
import type { TaskStore, ScheduleType, ContextMode } from "../scheduler/types.js";

export const CALLBACK_PORT = 7420;

export function startCallbackServer(
  workerManager: WorkerManager,
  buildDispatchContext: (token: string) => DispatchContext | null,
  taskStore?: TaskStore,
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

    const hook = buildPreToolUseHook(
      ctx.userId,
      ctx.userPlatform,
      ctx.platformConfig,
      agentRules,
      ctx.agentCwd,
      ctx.platformRoot,
      ctx.askApproval,
    );

    const result = await hook({ tool_name, tool_input });
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

    try {
      const result = await handleAgentStart(args, ctx, dispatchCtx, workerManager);
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

    const { runId } = await c.req.json() as { runId: string };
    await handleAgentStop(runId);
    return c.json({ ok: true });
  });

  // ── Agent tool: message ──
  app.post("/cb/:token/agent/message", async (c) => {
    const token = c.req.param("token");
    const ctx = getCallbackSession(token);
    if (!ctx) return c.json({ error: "Unknown callback token" }, 404);

    const { target, text } = await c.req.json() as { target: string; text: string };
    const ok = await handleAgentMessage(target, text);
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

  const server = serve({ fetch: app.fetch, port: CALLBACK_PORT }, () => {
    console.log(`[callback] Orchestrator callback server on port ${CALLBACK_PORT}`);
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
