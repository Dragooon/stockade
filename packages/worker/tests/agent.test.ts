import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkerRunRequest } from "../src/types.js";

// Mock the Agent SDK before importing agent module
const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

// Import after mock is set up
const { runAgent } = await import("../src/agent.js");

/** Helper: create an async iterable from an array of messages */
function fakeStream(messages: Record<string, unknown>[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) {
        yield msg;
      }
    },
  };
}

describe("runAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns result and sessionId from a successful run", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-abc123" },
        { type: "assistant", content: "thinking..." },
        { type: "result", result: "Hello, world!" },
      ])
    );

    const request: WorkerRunRequest = { prompt: "Say hello" };
    const response = await runAgent(request);

    expect(response.result).toBe("Hello, world!");
    expect(response.sessionId).toBe("sess-abc123");
  });

  it("passes sessionId for session resumption", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-existing" },
        { type: "result", result: "Resumed!" },
      ])
    );

    const request: WorkerRunRequest = {
      prompt: "Continue",
      sessionId: "sess-existing",
    };
    await runAgent(request);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          resume: "sess-existing",
        }),
      })
    );
  });

  it("uses default tools when none specified", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-1" },
        { type: "result", result: "done" },
      ])
    );

    await runAgent({ prompt: "test" });

    // When no tools specified, allowedTools should be omitted (enables all tools)
    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options).not.toHaveProperty("allowedTools");
  });

  it("uses custom tools when provided", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-2" },
        { type: "result", result: "done" },
      ])
    );

    await runAgent({ prompt: "search", tools: ["WebSearch", "WebFetch"] });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          allowedTools: ["WebSearch", "WebFetch"],
        }),
      })
    );
  });

  it("uses custom model when provided", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-3" },
        { type: "result", result: "done" },
      ])
    );

    await runAgent({ prompt: "test", model: "opus" });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          model: "opus",
        }),
      })
    );
  });

  it("defaults model to sonnet", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-4" },
        { type: "result", result: "done" },
      ])
    );

    await runAgent({ prompt: "test" });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          model: "sonnet",
        }),
      })
    );
  });

  it("defaults maxTurns to 20", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-5" },
        { type: "result", result: "done" },
      ])
    );

    await runAgent({ prompt: "test" });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          maxTurns: 20,
        }),
      })
    );
  });

  it("passes custom maxTurns", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-6" },
        { type: "result", result: "done" },
      ])
    );

    await runAgent({ prompt: "test", maxTurns: 5 });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          maxTurns: 5,
        }),
      })
    );
  });

  it("passes systemPrompt when provided", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-7" },
        { type: "result", result: "done" },
      ])
    );

    await runAgent({ prompt: "test", systemPrompt: "You are helpful." });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          systemPrompt: "You are helpful.",
        }),
      })
    );
  });

  it("does not pass resume when sessionId is absent", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-8" },
        { type: "result", result: "done" },
      ])
    );

    await runAgent({ prompt: "test" });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          resume: undefined,
        }),
      })
    );
  });
});
