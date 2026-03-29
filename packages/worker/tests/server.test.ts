import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the agent module before importing server
vi.mock("../src/agent.js", () => ({
  runAgent: vi.fn(),
}));

const { runAgent } = await import("../src/agent.js");
const mockRunAgent = vi.mocked(runAgent);

const { app } = await import("../src/server.js");

describe("GET /health", () => {
  it("returns ok and workerId", async () => {
    const res = await app.request("/health");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("workerId");
  });
});

describe("POST /run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns result and sessionId on success", async () => {
    mockRunAgent.mockResolvedValue({
      result: "Hello!",
      sessionId: "sess-abc",
    });

    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Say hi" }),
    });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.result).toBe("Hello!");
    expect(body.sessionId).toBe("sess-abc");
  });

  it("passes all fields to runAgent", async () => {
    mockRunAgent.mockResolvedValue({
      result: "done",
      sessionId: "sess-xyz",
    });

    await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Do something",
        systemPrompt: "Be helpful",
        tools: ["Bash", "Read"],
        model: "opus",
        sessionId: "sess-resume",
        maxTurns: 10,
      }),
    });

    expect(mockRunAgent).toHaveBeenCalledWith({
      prompt: "Do something",
      systemPrompt: "Be helpful",
      tools: ["Bash", "Read"],
      model: "opus",
      sessionId: "sess-resume",
      maxTurns: 10,
    });
  });

  it("returns 400 when prompt is missing", async () => {
    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("returns 400 when prompt is empty string", async () => {
    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("returns 500 when runAgent throws", async () => {
    mockRunAgent.mockRejectedValue(new Error("SDK failure"));

    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("returns 400 or 500 gracefully for malformed JSON body", async () => {
    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    // Hono's c.req.json() throws on invalid JSON — should not crash the server
    expect([400, 500]).toContain(res.status);
  });

  it("returns 400 or 500 gracefully for empty body", async () => {
    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    expect([400, 500]).toContain(res.status);
  });
});
