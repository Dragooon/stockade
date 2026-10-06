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

  it("skips the zero-turn task-notification result emitted on resume and waits for the reply", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { session_id: "sdk-sess-6" },
        { type: "system", subtype: "task_notification", status: "stopped" },
        { result: "", stop_reason: null, num_turns: 0, origin: { kind: "task-notification" } },
        { type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: "text", text: "hi" }] } },
        { result: "hi", stop_reason: "end_turn", num_turns: 1 },
      ]),
    );

    const channel = new ConversationChannel();
    channel.push("hello");
    setTimeout(() => channel.close(), 10);

    const events: any[] = [];
    await runAgentSession(BASE_REQUEST, channel, (ev) => events.push(ev));

    const results = events.filter((e) => e.type === "result");
    expect(results.length).toBe(1);
    expect(results[0].text).toBe("hi");
    expect(results[0].stopReason).toBe("end_turn");
  });

  describe("background follow-ups", () => {
    const tasks = (...ids: string[]) => ({ type: "system", subtype: "background_tasks_changed", tasks: ids.map((task_id) => ({ task_id, task_type: "local_bash", description: "sweep" })) });
    const say = (text: string, input_tokens: number) => ({ type: "assistant", message: { usage: { input_tokens, output_tokens: 3 }, content: [{ type: "text", text }] } });

    it("keeps reading after the reply while a task runs, and emits the turn it wakes as another result", async () => {
      mockQuery.mockReturnValue(
        fakeStream([
          { session_id: "s" },
          tasks("b1"),
          say("Started, shortlist coming", 10),
          { result: "Started, shortlist coming", stop_reason: "end_turn", num_turns: 2 },
          tasks(),
          { type: "system", subtype: "task_notification", task_id: "b1", status: "completed" },
          { type: "system", subtype: "init" },
          say("Shortlist: 3 lots", 20),
          { result: "Shortlist: 3 lots", stop_reason: "end_turn", num_turns: 1, origin: { kind: "task-notification" } },
          // Past the point it should stop reading: no tasks left after the follow-up.
          { result: "never read", stop_reason: "end_turn", num_turns: 1 },
        ]),
      );
      const channel = new ConversationChannel();
      channel.push("run the sweep");
      setTimeout(() => channel.close(), 10);
      const events: any[] = [];
      await runAgentSession(BASE_REQUEST, channel, (ev) => events.push(ev));

      expect(events.filter((e) => e.type === "result").map((e) => e.text)).toEqual(["Started, shortlist coming", "Shortlist: 3 lots"]);
    });

    it("lets a follow-up turn stay silent with no_reply", async () => {
      mockQuery.mockReturnValue(
        fakeStream([
          { session_id: "s" },
          tasks("b1"),
          { result: "Started", stop_reason: "end_turn", num_turns: 1 },
          tasks(),
          { type: "system", subtype: "init" },
          { type: "assistant", message: { usage: { input_tokens: 30, output_tokens: 2 }, content: [{ type: "tool_use", id: "t9", name: "mcp__agent__no_reply", input: {} }] } },
          { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t9" }] } },
          { result: "nothing new", stop_reason: "end_turn", num_turns: 2, origin: { kind: "task-notification" } },
        ]),
      );
      const channel = new ConversationChannel();
      channel.push("go");
      setTimeout(() => channel.close(), 10);
      const events: any[] = [];
      await runAgentSession(BASE_REQUEST, channel, (ev) => events.push(ev));
      expect(events.filter((e) => e.type === "result").map((e) => [e.text, !!e.silent])).toEqual([["Started", false], ["", true]]);
    });

    it("ignores ambient tasks", async () => {
      mockQuery.mockReturnValue(
        fakeStream([
          { session_id: "s" },
          { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w", task_type: "watcher", description: "", ambient: true }] },
          { result: "done", stop_reason: "end_turn", num_turns: 1 },
          { result: "never read", stop_reason: "end_turn", num_turns: 1 },
        ]),
      );
      const channel = new ConversationChannel();
      channel.push("hi");
      setTimeout(() => channel.close(), 10);
      const events: any[] = [];
      await runAgentSession(BASE_REQUEST, channel, (ev) => events.push(ev));
      expect(events.filter((e) => e.type === "result").map((e) => e.text)).toEqual(["done"]);
    });

    it("closes the CLI when the session closes while a task still runs", async () => {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const close = vi.fn(() => release());
      mockQuery.mockReturnValue({
        close,
        async *[Symbol.asyncIterator]() {
          yield { session_id: "s" };
          yield tasks("b1");
          yield { result: "started", stop_reason: "end_turn", num_turns: 1 };
          await released;
        },
      });
      const channel = new ConversationChannel();
      channel.push("go");
      const events: any[] = [];
      const done = runAgentSession(BASE_REQUEST, channel, (ev) => events.push(ev));
      await new Promise((r) => setTimeout(r, 20));
      expect(close).not.toHaveBeenCalled();
      channel.close();
      await done;
      expect(close).toHaveBeenCalledOnce();
      expect(events.filter((e) => e.type === "result").map((e) => e.text)).toEqual(["started"]);
    });
  });

  describe("no_reply", () => {
    const usage = { input_tokens: 10, output_tokens: 5 };
    const noReply = (text?: string) => ({
      type: "assistant",
      message: {
        usage,
        content: [
          ...(text ? [{ type: "text", text }] : []),
          { type: "tool_use", id: "t1", name: "mcp__agent__no_reply", input: {} },
        ],
      },
    });
    const toolResult = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } };

    async function run(stream: Record<string, unknown>[], onUser?: (channel: ConversationChannel) => void) {
      const channel = new ConversationChannel();
      channel.push("[sender: shitiz] see you at 7, Kinjal");
      mockQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          for (const msg of stream) {
            yield msg;
            if (msg.type === "user") onUser?.(channel);
          }
        },
      });
      setTimeout(() => channel.close(), 10);
      const events: any[] = [];
      await runAgentSession(BASE_REQUEST, channel, (ev) => events.push(ev));
      return events;
    }

    it("drops the final text and marks the result silent", async () => {
      const events = await run([
        { session_id: "s" },
        noReply("Not for me."),
        toolResult,
        { result: "(staying quiet)", stop_reason: "end_turn" },
      ]);
      const result = events.find((e) => e.type === "result");
      expect(result.text).toBe("");
      expect(result.silent).toBe(true);
      expect(events.some((e) => e.type === "assistant_text")).toBe(false);
    });

    it("is cancelled by a later tool call", async () => {
      const events = await run([
        { session_id: "s" },
        noReply(),
        toolResult,
        { type: "assistant", message: { usage: { input_tokens: 11, output_tokens: 5 }, content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2" }] } },
        { result: "Actually, here's the answer", stop_reason: "end_turn" },
      ]);
      const result = events.find((e) => e.type === "result");
      expect(result.text).toBe("Actually, here's the answer");
      expect(result.silent).toBeUndefined();
    });

    it("is cancelled by a message arriving after the model chose silence", async () => {
      const events = await run(
        [{ session_id: "s" }, noReply(), toolResult, { result: "Sure, on it", stop_reason: "end_turn" }],
        (channel) => channel.push("[sender: kinjal] Madge, what's the weather?"),
      );
      const result = events.find((e) => e.type === "result");
      expect(result.text).toBe("Sure, on it");
      expect(result.silent).toBeUndefined();
    });

    it("is seen in a split message whose usage repeats the previous one", async () => {
      const events = await run([
        { session_id: "s" },
        { type: "assistant", message: { usage, content: [{ type: "thinking", thinking: "chatter" }] } },
        noReply(),
        toolResult,
        { result: "ok", stop_reason: "end_turn" },
      ]);
      expect(events.find((e) => e.type === "result").silent).toBe(true);
    });
  });
});
