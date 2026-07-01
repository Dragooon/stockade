/**
 * Worker HTTP server — session-based API.
 *
 * Routes:
 *   POST   /sessions              — create and start a new agent session
 *   GET    /sessions/:id/events   — SSE stream of WorkerEvent
 *   POST   /sessions/:id/inject   — inject a message into the running session
 *   DELETE /sessions/:id          — abort the session and clean up
 *   GET    /health                — liveness check
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { WorkerSessionRequestSchema } from "./types.js";
import { WorkerSession } from "./session.js";
import type { WorkerRedisBridge } from "./redis-bridge.js";

export const app = new Hono();

const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;

/** Set by index.ts when REDIS_URL is configured. Shared across all sessions. */
let redisBridge: WorkerRedisBridge | null = null;

export function setRedisBridge(bridge: WorkerRedisBridge): void {
  redisBridge = bridge;
}

/** Active sessions keyed by worker session ID. */
const sessions = new Map<string, WorkerSession>();

/**
 * Maps a Redis scope → its current persistent worker session ID.
 *
 * A persistent session subscribes to stockade:msg:{scope}. If the orchestrator
 * re-POSTs /sessions for a scope while this worker container keeps running
 * (e.g. after an orchestrator restart, whose in-memory session map starts
 * empty), a second WorkerSession would stack another subscription on the same
 * channel — and every inbound message would then fan out to BOTH loops,
 * producing duplicate ("double-firing") replies. This grows by one per
 * orchestrator restart. Tracking the live session per scope lets us evict the
 * superseded one so exactly one loop answers each scope.
 */
const scopeToSessionId = new Map<string, string>();

app.get("/health", (c) => {
  return c.json({ ok: true, workerId, sessions: sessions.size });
});

app.post("/sessions", async (c) => {
  const body = await c.req.json();
  const parsed = WorkerSessionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const request = parsed.data;

  // Scope-dedupe: a persistent session for this scope may already be running
  // (orchestrator restarted and re-POSTed while this container survived). Abort
  // the superseded one before subscribing a new loop, otherwise both stay
  // subscribed to stockade:msg:{scope} and every message double-fires. abort()
  // wakes the old loop, which unsubscribes only its own handler — the new
  // session's handler (subscribed below) is unaffected.
  if (request.redisMode && request.scope) {
    const priorId = scopeToSessionId.get(request.scope);
    if (priorId) {
      const prior = sessions.get(priorId);
      if (prior) {
        prior.abort();
        sessions.delete(priorId);
        console.log(
          `[worker] Evicted superseded session ${priorId.slice(0, 8)} for scope ${request.scope.slice(0, 40)}`,
        );
      }
      scopeToSessionId.delete(request.scope);
    }
  }

  const workerSessionId = randomUUID();
  const session = new WorkerSession();

  sessions.set(workerSessionId, session);
  if (request.redisMode && request.scope) {
    scopeToSessionId.set(request.scope, workerSessionId);
  }

  // Start session: Redis mode (persistent loop) or SSE mode (one-shot)
  if (request.redisMode && redisBridge) {
    // Await subscription confirmation — ensures the worker is subscribed to
    // Redis before the HTTP response returns, so the orchestrator won't publish
    // the first message before the worker is listening.
    await session.startPersistent(request as any, redisBridge);
  } else {
    session.start(request as any);
  }

  // Auto-remove session when it finishes (with a delay for late SSE connects)
  const cleanup = () => {
    setTimeout(() => {
      sessions.delete(workerSessionId);
      // Only clear the scope mapping if it still points at this session — a
      // newer session may have superseded it (which already re-pointed it).
      if (request.scope && scopeToSessionId.get(request.scope) === workerSessionId) {
        scopeToSessionId.delete(request.scope);
      }
    }, 30_000);
  };
  // Check periodically if done (can't subscribe here without conflicting)
  const pollDone = setInterval(() => {
    if (session.done) {
      clearInterval(pollDone);
      cleanup();
    }
  }, 1_000);

  console.log(`[worker] Session ${workerSessionId.slice(0, 8)} created`);
  return c.json({ workerSessionId });
});

app.get("/sessions/:id/events", (c) => {
  const id = c.req.param("id");
  const session = sessions.get(id);

  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  // SSE: stream WorkerEvents as "data: <json>\n\n"
  const { readable, writable } = new TransformStream<string, string>();
  const writer = writable.getWriter();

  const write = (line: string) => writer.write(line).catch(() => {});

  const sendEvent = (event: unknown) => {
    write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Subscribe — drains buffered events immediately, then real-time
  session.subscribe((event) => {
    sendEvent(event);
    if (event.type === "result" || event.type === "error" || event.type === "stale_session") {
      writer.close().catch(() => {});
    }
  });

  // If session is already done and no events will come, close now
  if (session.done) {
    writer.close().catch(() => {});
  }

  return new Response(readable as any, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

app.post("/sessions/:id/inject", async (c) => {
  const id = c.req.param("id");
  const session = sessions.get(id);

  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  if (session.done) {
    return c.json({ error: "Session is done" }, 409);
  }

  const { text } = await c.req.json() as { text: string };
  if (!text) {
    return c.json({ error: "text is required" }, 400);
  }

  session.inject(text);
  return c.json({ ok: true });
});

app.delete("/sessions/:id", (c) => {
  const id = c.req.param("id");
  const session = sessions.get(id);

  if (session) {
    session.abort();
    sessions.delete(id);
    for (const [scope, sid] of scopeToSessionId) {
      if (sid === id) scopeToSessionId.delete(scope);
    }
    console.log(`[worker] Session ${id.slice(0, 8)} deleted`);
  }

  return c.json({ ok: true });
});
