import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the session module so we control when events are emitted
vi.mock("../src/session.js", () => {
  const EventEmitter = class {
    private listeners: Array<(ev: unknown) => void> = [];
    private buffer: unknown[] = [];
    private _done = false;

    get done() { return this._done; }

    subscribe(fn: (ev: unknown) => void) {
      for (const ev of this.buffer) fn(ev);
      this.listeners.push(fn);
    }

    emit(ev: unknown) {
      this.buffer.push(ev);
      for (const l of this.listeners) l(ev);
      if ((ev as any).type === "result" || (ev as any).type === "error") {
        this._done = true;
      }
    }

    inject(_text: string) {}
    abort() {}
    start(_req: unknown) {
      // Emit a result immediately for test purposes
      setTimeout(() => this.emit({ type: "result", text: "done", sessionId: "sdk-abc", stopReason: "end_turn" }), 0);
    }
  };

  return { WorkerSession: EventEmitter };
});

const { app } = await import("../src/server.js");

describe("GET /health", () => {
  it("returns ok with workerId and session count", async () => {
    const res = await app.request("/health");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("workerId");
    expect(body).toHaveProperty("sessions");
  });
});

describe("POST /sessions", () => {
  it("returns workerSessionId on valid request", async () => {
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Hello",
        orchestratorUrl: "http://localhost:7420",
        callbackToken: "test-token",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("workerSessionId");
    expect(typeof body.workerSessionId).toBe("string");
  });

  it("returns 400 when prompt is missing", async () => {
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orchestratorUrl: "http://localhost:7420",
        callbackToken: "test-token",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("returns 400 when orchestratorUrl is missing", async () => {
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Hello",
        callbackToken: "test-token",
      }),
    });

    expect(res.status).toBe(400);
  });
});

describe("POST /sessions/:id/inject", () => {
  it("returns 404 for unknown session", async () => {
    const res = await app.request("/sessions/nonexistent/inject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /sessions/:id", () => {
  it("returns ok even for unknown session (idempotent)", async () => {
    const res = await app.request("/sessions/nonexistent", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
