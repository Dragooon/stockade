import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversationChannel } from "../src/channel.js";
import type { WorkerSessionRequest } from "../src/types.js";

// Mock the Agent SDK
const mockQuery = vi.fn();
const mockTool = vi.fn().mockImplementation((_name: string, _desc: string, _schema: unknown, fn: Function) => fn);
const mockCreateSdkMcpServer = vi.fn().mockReturnValue({});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  tool: (...args: unknown[]) => mockTool(...args),
  createSdkMcpServer: (...args: unknown[]) => mockCreateSdkMcpServer(...args),
}));

const { runAgentSession } = await import("../src/agent.js");

/** Helper: create an async iterable from an array of messages */
function fakeStream(messages: Record<string, unknown>[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) yield msg;
    },
  };
}

const BASE_REQUEST: WorkerSessionRequest = {
  prompt: "test",
  orchestratorUrl: "http://localhost:7420",
  callbackToken: "test-token",
};

describe("runAgentSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits started event with SDK session ID", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { session_id: "sdk-sess-1" },
        { result: "done", stop_reason: "end_turn" },
      ]),
    );

    const channel = new ConversationChannel();
    channel.push("hello");
    setTimeout(() => channel.close(), 10);

    const events: unknown[] = [];
    await runAgentSession(BASE_REQUEST, channel, (ev) => events.push(ev));

    const started = events.find((e: any) => e.type === "started") as any;
    expect(started?.sessionId).toBe("sdk-sess-1");
  });

  it("emits result event with text and sessionId", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { session_id: "sdk-sess-2" },
        { result: "Hello, world!", stop_reason: "end_turn" },
      ]),
    );

    const channel = new ConversationChannel();
    channel.push("hello");
    setTimeout(() => channel.close(), 10);

    const events: unknown[] = [];
    await runAgentSession(BASE_REQUEST, channel, (ev) => events.push(ev));

    const result = events.find((e: any) => e.type === "result") as any;
    expect(result?.text).toBe("Hello, world!");
    expect(result?.sessionId).toBe("sdk-sess-2");
    expect(result?.stopReason).toBe("end_turn");
  });

  it("emits stale_session event on stale session error", async () => {
    mockQuery.mockImplementation(function* () {
      throw new Error("No conversation found with the given session_id");
    });

    const channel = new ConversationChannel();
    channel.push("hello");

    const events: unknown[] = [];
    await runAgentSession(
      { ...BASE_REQUEST, sessionId: "stale-session" },
      channel,
      (ev) => events.push(ev),
    );

    const stale = events.find((e: any) => e.type === "stale_session");
    expect(stale).toBeDefined();
  });

  it("passes resume option when sessionId provided", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { session_id: "sdk-sess-3" },
        { result: "resumed", stop_reason: "end_turn" },
      ]),
    );

    const channel = new ConversationChannel();
    channel.push("hello");
    setTimeout(() => channel.close(), 10);

    await runAgentSession(
      { ...BASE_REQUEST, sessionId: "existing-session" },
      channel,
      () => {},
    );

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ resume: "existing-session" }),
      }),
    );
  });

  it("uses bypassPermissions mode", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { session_id: "sdk-sess-4" },
        { result: "done", stop_reason: "end_turn" },
      ]),
    );

    const channel = new ConversationChannel();
    channel.push("hello");
    setTimeout(() => channel.close(), 10);

    await runAgentSession(BASE_REQUEST, channel, () => {});

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ permissionMode: "bypassPermissions" }),
      }),
    );
  });

  it("emits turn events for each assistant message", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { session_id: "sdk-sess-5" },
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 100, output_tokens: 50 },
            content: [],
          },
        },
        { result: "done", stop_reason: "end_turn" },
      ]),
    );

    const channel = new ConversationChannel();
    channel.push("hello");
    setTimeout(() => channel.close(), 10);

    const events: unknown[] = [];
    await runAgentSession(BASE_REQUEST, channel, (ev) => events.push(ev));

    const turns = events.filter((e: any) => e.type === "turn");
    expect(turns.length).toBe(1);
    expect((turns[0] as any).input).toBe(100);
    expect((turns[0] as any).output).toBe(50);
  });
});
