import { describe, it, expect, vi } from "vitest";
import type { ConversationChannel } from "../src/channel.js";
import type { WorkerEvent } from "../src/types.js";

const mockRun = vi.fn();
vi.mock("../src/agent.js", () => ({ runAgentSession: (...args: unknown[]) => mockRun(...args) }));

const { WorkerSession } = await import("../src/session.js");

function fakeBridge() {
  let handler: ((msg: { correlationId: string; text: string }) => void) | undefined;
  const published: any[] = [];
  return {
    published,
    send: (correlationId: string, text: string) => handler!({ correlationId, text }),
    bridge: {
      subscribeScope: async (_scope: string, h: typeof handler) => { handler = h; },
      unsubscribeScope: async () => {},
      publishEvent: async (_scope: string, ev: unknown) => { published.push(ev); },
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("WorkerSession follow-ups", () => {
  it("publishes a result nobody waits on as a follow-up, and gives a message sent after the reply the next result", async () => {
    let step!: () => void;
    const pushed: string[] = [];
    mockRun.mockImplementation(async (_req: unknown, channel: ConversationChannel, emit: (ev: WorkerEvent) => void) => {
      emit({ type: "result", text: "started, shortlist coming", sessionId: "s", stopReason: "end_turn" });
      await new Promise<void>((r) => (step = r));
      emit({ type: "result", text: "shortlist: 3 lots", sessionId: "s", stopReason: "end_turn" });
      await new Promise<void>((r) => (step = r));
      for await (const m of channel) { pushed.push(m.message.content); if (pushed.length === 2) break; }
      emit({ type: "result", text: "lot 2", sessionId: "s", stopReason: "end_turn" });
    });

    const f = fakeBridge();
    const session = new WorkerSession();
    await session.startPersistent({ prompt: "", orchestratorUrl: "http://x", callbackToken: "t", scope: "discord:g:c" }, f.bridge as any);
    f.send("cid-1", "run the sweep");
    await tick();
    step(); // the background task finished: the agent speaks again unprompted
    await tick();
    f.send("cid-2", "which is best?"); // arrives while the query is still alive
    await tick();
    step();
    await tick();
    session.abort();

    expect(pushed).toEqual(["run the sweep", "which is best?"]);
    const results = f.published.filter((e) => e.kind === "evt:result");
    expect(results.map((e) => [e.followup ? "follow-up" : e.correlationId, e.text])).toEqual([
      ["cid-1", "started, shortlist coming"],
      ["follow-up", "shortlist: 3 lots"],
      ["cid-2", "lot 2"],
    ]);
    expect(results[1].correlationId).toMatch(/^followup:/);
  });
});
