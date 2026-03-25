import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentConfig, ChannelMessage } from "../src/types.js";

// Mock the Agent SDK before importing dispatcher
const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

// Mock global fetch for remote dispatch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { dispatch } = await import("../src/dispatcher.js");

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

const baseMessage: ChannelMessage = {
  scope: "terminal:uuid:alice",
  content: "Hello, agent!",
  userId: "alice",
  platform: "terminal",
};

const localAgent: AgentConfig = {
  model: "claude-sonnet-4-20250514",
  system: "You are helpful.",
  tools: ["Bash", "Read"],
  lifecycle: "persistent",
  remote: false,
};

const remoteAgent: AgentConfig = {
  model: "claude-haiku-4-5-20251001",
  system: "You research.",
  tools: ["WebSearch"],
  lifecycle: "persistent",
  remote: true,
  port: 3001,
  url: "http://localhost:3001",
};

describe("dispatch — in-process (local)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls Agent SDK query and returns result + sessionId", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-local-1" },
        { type: "assistant", content: "thinking..." },
        { type: "result", result: "Hello back!", session_id: "sess-local-1" },
      ])
    );

    const result = await dispatch("main", baseMessage, localAgent, null);

    expect(result.result).toBe("Hello back!");
    expect(result.sessionId).toBe("sess-local-1");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Hello, agent!",
        options: expect.objectContaining({
          model: "claude-sonnet-4-20250514",
          systemPrompt: "You are helpful.",
          allowedTools: ["Bash", "Read"],
          maxTurns: 20,
        }),
      })
    );
    // No resume when sessionId is null
    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.resume).toBeUndefined();
  });

  it("passes existing sessionId for resume", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-resumed" },
        { type: "result", result: "Resumed!" },
      ])
    );

    await dispatch("main", baseMessage, localAgent, "sess-existing");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          resume: "sess-existing",
        }),
      })
    );
  });

  it("passes permission hook as canUseTool", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-perm" },
        { type: "result", result: "Done" },
      ])
    );

    const hook = vi.fn().mockResolvedValue({ behavior: "allow", updatedInput: {} });
    await dispatch("main", baseMessage, localAgent, null, hook);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          canUseTool: hook,
        }),
      })
    );
  });
});

describe("dispatch — remote (HTTP)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POSTs to worker URL and returns result", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: "Remote result",
        sessionId: "sess-remote-1",
      }),
    });

    const result = await dispatch(
      "researcher",
      baseMessage,
      remoteAgent,
      null
    );

    expect(result.result).toBe("Remote result");
    expect(result.sessionId).toBe("sess-remote-1");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/run",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );

    // Verify the body
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.prompt).toBe("Hello, agent!");
    expect(callBody.model).toBe("claude-haiku-4-5-20251001");
    expect(callBody.tools).toEqual(["WebSearch"]);
  });

  it("passes sessionId for remote resume", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: "Resumed remotely",
        sessionId: "sess-remote-2",
      }),
    });

    await dispatch(
      "researcher",
      baseMessage,
      remoteAgent,
      "sess-existing-remote"
    );

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.sessionId).toBe("sess-existing-remote");
  });

  it("falls back to port-based URL when url is not set", async () => {
    const agentNoUrl: AgentConfig = {
      ...remoteAgent,
      url: undefined,
      port: 4000,
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: "ok", sessionId: "sess-3" }),
    });

    await dispatch("researcher", baseMessage, agentNoUrl, null);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/run",
      expect.anything()
    );
  });

  it("throws on non-OK HTTP response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    await expect(
      dispatch("researcher", baseMessage, remoteAgent, null)
    ).rejects.toThrow("Worker responded with 500");
  });
});
