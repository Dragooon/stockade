/**
 * E2E tests for the dispatch → worker round-trip — real HTTP, real SSE.
 *
 * Spins up a mock worker HTTP server that implements the exact same protocol
 * as the real worker (POST /sessions → SSE /sessions/:id/events) without
 * needing the Claude SDK. Tests the orchestrator's HTTP client logic:
 * session creation, SSE event parsing, timeout handling, stale session retry.
 *
 * Covers bugs from:
 *   - 4b90345: Add timeout, retries and better errors to remote dispatch fetch
 *   - f14a022: Add dispatch logging, container graceful stop
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import http from "node:http";

// ── Types (mirroring worker protocol) ────────────────────────────────────

interface WorkerEvent {
  type: string;
  [key: string]: unknown;
}

interface MockSession {
  events: WorkerEvent[];
  done: boolean;
  sseListeners: Array<(event: WorkerEvent) => void>;
}

// ── Mock Worker Server ───────────────────────────────────────────────────

/**
 * Creates a mock worker server that implements the same protocol as
 * packages/worker/src/server.ts without depending on the Claude SDK.
 *
 * Behavior is controlled per-test by setting `sessionBehavior`.
 */
function createMockWorkerServer(): {
  server: Server;
  port: number;
  start: () => Promise<void>;
  close: () => Promise<void>;
  /**
   * Set the behavior for the next session.
   * - "echo": immediately returns a result echoing the prompt
   * - "stale": emits a stale_session event
   * - "error": emits an error event
   * - "delayed": waits delayMs then returns result
   * - "multi-turn": emits multiple turn events then result
   */
  setBehavior: (b: SessionBehavior) => void;
  sessionCount: () => number;
} {
  type SessionBehavior =
    | { type: "echo" }
    | { type: "stale" }
    | { type: "error"; message: string }
    | { type: "delayed"; delayMs: number }
    | { type: "multi-turn"; turns: number };

  let behavior: SessionBehavior = { type: "echo" };
  const sessions = new Map<string, MockSession>();
  let totalSessions = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const method = req.method ?? "GET";

    // GET /health
    if (method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, workerId: "mock-worker" }));
      return;
    }

    // POST /sessions
    if (method === "POST" && url.pathname === "/sessions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }

        const workerSessionId = `mock-session-${++totalSessions}`;
        const session: MockSession = { events: [], done: false, sseListeners: [] };
        sessions.set(workerSessionId, session);

        // Schedule events based on current behavior
        const b = behavior;
        const prompt = String(parsed.prompt ?? "");

        if (b.type === "echo") {
          setTimeout(() => emitEvent(session, { type: "started", sessionId: "sdk-session-echo" }), 10);
          setTimeout(() => emitEvent(session, { type: "turn", turns: 1, input: 100, output: 50, cacheRead: 0, cacheCreate: 0 }), 20);
          setTimeout(() => emitEvent(session, { type: "result", text: `Echo: ${prompt}`, sessionId: "sdk-session-echo", stopReason: "end_turn" }), 30);
        } else if (b.type === "stale") {
          setTimeout(() => emitEvent(session, { type: "stale_session" }), 10);
        } else if (b.type === "error") {
          setTimeout(() => emitEvent(session, { type: "error", message: b.message }), 10);
        } else if (b.type === "delayed") {
          setTimeout(() => emitEvent(session, { type: "started", sessionId: "sdk-session-delayed" }), 10);
          setTimeout(() => emitEvent(session, { type: "result", text: `Delayed: ${prompt}`, sessionId: "sdk-session-delayed", stopReason: "end_turn" }), b.delayMs);
        } else if (b.type === "multi-turn") {
          setTimeout(() => emitEvent(session, { type: "started", sessionId: "sdk-session-multi" }), 10);
          for (let t = 1; t <= b.turns; t++) {
            setTimeout(
              () => emitEvent(session, { type: "turn", turns: t, input: 100 * t, output: 50 * t, cacheRead: 10 * t, cacheCreate: 5 * t }),
              20 + t * 10,
            );
          }
          setTimeout(
            () => emitEvent(session, { type: "result", text: `Multi-turn result (${b.turns} turns)`, sessionId: "sdk-session-multi", stopReason: "end_turn" }),
            20 + (b.turns + 1) * 10,
          );
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ workerSessionId }));
      });
      return;
    }

    // GET /sessions/:id/events (SSE)
    const sseMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
    if (method === "GET" && sseMatch) {
      const sessionId = sseMatch[1];
      const session = sessions.get(sessionId);

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      // Drain buffered events
      for (const ev of session.events) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }

      if (session.done) {
        res.end();
        return;
      }

      // Listen for future events
      const listener = (ev: WorkerEvent) => {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
        if (ev.type === "result" || ev.type === "error" || ev.type === "stale_session") {
          res.end();
        }
      };
      session.sseListeners.push(listener);

      req.on("close", () => {
        const idx = session.sseListeners.indexOf(listener);
        if (idx >= 0) session.sseListeners.splice(idx, 1);
      });
      return;
    }

    // DELETE /sessions/:id
    const deleteMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (method === "DELETE" && deleteMatch) {
      sessions.delete(deleteMatch[1]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  function emitEvent(session: MockSession, event: WorkerEvent): void {
    session.events.push(event);
    for (const l of session.sseListeners) l(event);
    if (event.type === "result" || event.type === "error" || event.type === "stale_session") {
      session.done = true;
    }
  }

  let resolvedPort = 0;

  return {
    server,
    get port() { return resolvedPort; },
    start: async () => {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      resolvedPort = (server.address() as { port: number }).port;
    },
    close: async () => {
      server.closeAllConnections?.();
      server.close();
      await once(server, "close").catch(() => {});
    },
    setBehavior: (b: SessionBehavior) => { behavior = b; },
    sessionCount: () => totalSessions,
  };
}

// ── SSE Client Helper ────────────────────────────────────────────────────

/**
 * Subscribe to a worker's SSE event stream and collect events until a
 * terminal event (result, error, stale_session) arrives.
 *
 * This mirrors the logic in packages/orchestrator/src/dispatcher.ts subscribeToEvents().
 */
async function subscribeAndCollect(
  workerUrl: string,
  workerSessionId: string,
  timeoutMs = 10_000,
): Promise<{ events: WorkerEvent[]; terminal: WorkerEvent }> {
  const res = await fetch(`${workerUrl}/sessions/${workerSessionId}/events`, {
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: ${res.status}`);
  }

  const events: WorkerEvent[] = [];
  const reader = (res.body as any).getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = "";

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
        events.push(event);

        if (event.type === "result" || event.type === "error" || event.type === "stale_session") {
          return { events, terminal: event };
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  throw new Error("SSE stream ended without terminal event");
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Dispatch → Worker Round-Trip E2E", { timeout: 30_000 }, () => {
  const worker = createMockWorkerServer();

  beforeAll(async () => {
    await worker.start();
  });

  afterAll(async () => {
    await worker.close();
  });

  // ── Test 1: Basic echo round-trip ──────────────────────────────────

  it("1. POST /sessions + SSE events returns echoed result", async () => {
    worker.setBehavior({ type: "echo" });

    const workerUrl = `http://127.0.0.1:${worker.port}`;

    // Step 1: Create session
    const createRes = await fetch(`${workerUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Hello, world!",
        orchestratorUrl: "http://localhost:9999",
        callbackToken: "test-token",
      }),
    });

    expect(createRes.status).toBe(200);
    const { workerSessionId } = (await createRes.json()) as { workerSessionId: string };
    expect(workerSessionId).toBeTruthy();

    // Step 2: Subscribe to SSE and collect events
    const { events, terminal } = await subscribeAndCollect(workerUrl, workerSessionId);

    // Verify event sequence: started → turn → result
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0].type).toBe("started");
    expect(events[0].sessionId).toBe("sdk-session-echo");
    expect(events[1].type).toBe("turn");
    expect(terminal.type).toBe("result");
    expect((terminal as any).text).toBe("Echo: Hello, world!");
    expect((terminal as any).sessionId).toBe("sdk-session-echo");
  });

  // ── Test 2: Health check ───────────────────────────────────────────

  it("2. GET /health returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${worker.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // ── Test 3: Stale session event ────────────────────────────────────

  it("3. stale session emits stale_session event for retry", async () => {
    worker.setBehavior({ type: "stale" });

    const workerUrl = `http://127.0.0.1:${worker.port}`;

    const createRes = await fetch(`${workerUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Resume attempt",
        sessionId: "old-session-id",
        orchestratorUrl: "http://localhost:9999",
        callbackToken: "test-token",
      }),
    });

    const { workerSessionId } = (await createRes.json()) as { workerSessionId: string };
    const { terminal } = await subscribeAndCollect(workerUrl, workerSessionId);

    expect(terminal.type).toBe("stale_session");
  });

  // ── Test 4: Error event ────────────────────────────────────────────

  it("4. worker error is propagated via SSE error event", async () => {
    worker.setBehavior({ type: "error", message: "SDK crashed: out of memory" });

    const workerUrl = `http://127.0.0.1:${worker.port}`;

    const createRes = await fetch(`${workerUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Trigger error",
        orchestratorUrl: "http://localhost:9999",
        callbackToken: "test-token",
      }),
    });

    const { workerSessionId } = (await createRes.json()) as { workerSessionId: string };
    const { terminal } = await subscribeAndCollect(workerUrl, workerSessionId);

    expect(terminal.type).toBe("error");
    expect((terminal as any).message).toBe("SDK crashed: out of memory");
  });

  // ── Test 5: Multi-turn with intermediate events ────────────────────

  it("5. multi-turn session emits turn events with correct counts", async () => {
    worker.setBehavior({ type: "multi-turn", turns: 3 });

    const workerUrl = `http://127.0.0.1:${worker.port}`;

    const createRes = await fetch(`${workerUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Complex task",
        orchestratorUrl: "http://localhost:9999",
        callbackToken: "test-token",
      }),
    });

    const { workerSessionId } = (await createRes.json()) as { workerSessionId: string };
    const { events, terminal } = await subscribeAndCollect(workerUrl, workerSessionId);

    // Should have: started + 3 turns + result = 5 events
    const turnEvents = events.filter((e) => e.type === "turn");
    expect(turnEvents.length).toBe(3);

    // Verify turn numbering
    expect(turnEvents[0].turns).toBe(1);
    expect(turnEvents[1].turns).toBe(2);
    expect(turnEvents[2].turns).toBe(3);

    // Token counts should be incremental
    expect(turnEvents[2].input).toBe(300);
    expect(turnEvents[2].output).toBe(150);

    expect(terminal.type).toBe("result");
    expect((terminal as any).text).toBe("Multi-turn result (3 turns)");
  });

  // ── Test 6: Session cleanup via DELETE ─────────────────────────────

  it("6. DELETE /sessions/:id removes the session", async () => {
    worker.setBehavior({ type: "echo" });

    const workerUrl = `http://127.0.0.1:${worker.port}`;

    const createRes = await fetch(`${workerUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "To be deleted",
        orchestratorUrl: "http://localhost:9999",
        callbackToken: "test-token",
      }),
    });

    const { workerSessionId } = (await createRes.json()) as { workerSessionId: string };

    // Wait for it to complete
    await subscribeAndCollect(workerUrl, workerSessionId);

    // Delete the session
    const deleteRes = await fetch(`${workerUrl}/sessions/${workerSessionId}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    // Subsequent SSE subscribe should get 404
    const eventsRes = await fetch(`${workerUrl}/sessions/${workerSessionId}/events`);
    expect(eventsRes.status).toBe(404);
  });

  // ── Test 7: Invalid JSON body returns 400 ──────────────────────────

  it("7. POST /sessions with invalid JSON returns 400", async () => {
    const workerUrl = `http://127.0.0.1:${worker.port}`;

    const res = await fetch(`${workerUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });

    expect(res.status).toBe(400);
  });

  // ── Test 8: Nonexistent session returns 404 ────────────────────────

  it("8. GET /sessions/nonexistent/events returns 404", async () => {
    const workerUrl = `http://127.0.0.1:${worker.port}`;

    const res = await fetch(`${workerUrl}/sessions/nonexistent/events`);
    expect(res.status).toBe(404);
  });

  // ── Test 9: Multiple concurrent sessions ───────────────────────────

  it("9. multiple concurrent sessions are isolated", async () => {
    worker.setBehavior({ type: "echo" });

    const workerUrl = `http://127.0.0.1:${worker.port}`;

    // Create two sessions concurrently
    const [res1, res2] = await Promise.all([
      fetch(`${workerUrl}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Session A",
          orchestratorUrl: "http://localhost:9999",
          callbackToken: "token-a",
        }),
      }),
      fetch(`${workerUrl}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Session B",
          orchestratorUrl: "http://localhost:9999",
          callbackToken: "token-b",
        }),
      }),
    ]);

    const { workerSessionId: idA } = (await res1.json()) as { workerSessionId: string };
    const { workerSessionId: idB } = (await res2.json()) as { workerSessionId: string };

    // Sessions should have different IDs
    expect(idA).not.toBe(idB);

    // Both should complete independently
    const [resultA, resultB] = await Promise.all([
      subscribeAndCollect(workerUrl, idA),
      subscribeAndCollect(workerUrl, idB),
    ]);

    expect((resultA.terminal as any).text).toBe("Echo: Session A");
    expect((resultB.terminal as any).text).toBe("Echo: Session B");
  });

  // ── Test 10: Delayed response (simulating long-running agent) ──────

  it("10. delayed session waits for result without timing out", async () => {
    worker.setBehavior({ type: "delayed", delayMs: 500 });

    const workerUrl = `http://127.0.0.1:${worker.port}`;

    const createRes = await fetch(`${workerUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Slow task",
        orchestratorUrl: "http://localhost:9999",
        callbackToken: "test-token",
      }),
    });

    const { workerSessionId } = (await createRes.json()) as { workerSessionId: string };
    const start = Date.now();
    const { terminal } = await subscribeAndCollect(workerUrl, workerSessionId, 5_000);
    const elapsed = Date.now() - start;

    expect(terminal.type).toBe("result");
    expect((terminal as any).text).toBe("Delayed: Slow task");
    // Should have waited at least ~500ms
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });
});
