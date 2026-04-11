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
  const workerSessionId = randomUUID();
  const session = new WorkerSession();

  sessions.set(workerSessionId, session);

  // Start session: Redis mode (persistent loop) or SSE mode (one-shot)
  if (request.redisMode && redisBridge) {
    session.startPersistent(request as any, redisBridge);
  } else {
    session.start(request as any);
  }

  // Auto-remove session when it finishes (with a delay for late SSE connects)
  const cleanup = () => {
    setTimeout(() => sessions.delete(workerSessionId), 30_000);
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
    console.log(`[worker] Session ${id.slice(0, 8)} deleted`);
  }

  return c.json({ ok: true });
});
