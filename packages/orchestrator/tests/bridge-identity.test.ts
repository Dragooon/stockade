import { describe, it, expect, vi } from "vitest";

// Keep the test's lines out of the live dispatch.log.
vi.mock("../src/log.js", () => ({ appendLog: () => {} }));

const { OrchestratorBridge } = await import("../src/bus/orchestrator-bridge.js");

const SCOPE = "discord:g:c";

/** A bridge over a fake bus and session manager that records what reaches the worker. */
async function startBridge() {
  let onEvent!: (scope: string, event: any) => void;
  const published: Array<{ correlationId: string; text: string; userId: string }> = [];
  const ensureCalls: string[] = [];
  const bus = {
    subscribeAllEvents: async (callback: typeof onEvent) => { onEvent = callback; },
    subscribeWorkerLifecycle: async () => {},
    startListening: () => {},
    publishMessage: async (message: any) => { published.push(message); },
    shutdown: async () => {},
  };
  const sessionManager = {
    ensureSession: async (_scope: string, meta: any) => {
      ensureCalls.push(meta.userId);
      return { agentId: "main", agentCwd: "/tmp", sandboxed: false };
    },
    touch: () => {},
  };
  const bridge = new OrchestratorBridge(bus as any, sessionManager as any);
  await bridge.start();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const finishTurn = (correlationId: string, text: string) =>
    onEvent(SCOPE, {
      kind: "evt:result", scope: SCOPE, correlationId, text,
      sdkSessionId: "s", stopReason: "end_turn", timestamp: "",
    });
  return { bridge, published, ensureCalls, settle, finishTurn };
}

const fromPerson = (userId: string) => ({ userId, userPlatform: "discord" });

describe("OrchestratorBridge: universal mid-turn injection", () => {
  it("injects anyone's message into the running turn, applying each sender as it arrives", async () => {
    const { bridge, published, ensureCalls, settle, finishTurn } = await startBridge();
    const aliceTurn = bridge.sendAndWait(SCOPE, "alice asks", fromPerson("alice"));
    await settle();
    const bobMessage = bridge.sendAndWait(SCOPE, "bob adds", fromPerson("bob"));
    const aliceAgain = bridge.sendAndWait(SCOPE, "alice again", fromPerson("alice"));
    await settle();

    // Nothing waits: every message reaches the worker at once.
    expect(published.map((m) => m.text)).toEqual(["alice asks", "bob adds", "alice again"]);
    expect(ensureCalls).toEqual(["alice", "bob", "alice"]);
    expect(bridge.isTurnRunning(SCOPE)).toBe(true);

    // The worker answers the latest message; the others are coalesced into that reply.
    finishTurn(published[2].correlationId, "one reply for all three");
    expect((await aliceTurn).text).toBe("");
    expect((await bobMessage).text).toBe("");
    expect((await aliceAgain).text).toBe("one reply for all three");
    expect(bridge.isTurnRunning(SCOPE)).toBe(false);
  });

  it("coalesces onto a peer message when the turn's result lands on its correlation id", async () => {
    const { bridge, published, settle, finishTurn } = await startBridge();
    const discordTurn = bridge.sendAndWait(SCOPE, "from discord", fromPerson("alice"));
    await settle();
    const peerMessage = bridge.sendAndWait(SCOPE, "[peer: from #general …]", { ...fromPerson("bob"), hops: 1 });
    await settle();

    finishTurn(published[1].correlationId, "one reply for both");
    expect((await discordTurn).text).toBe("");
    expect((await peerMessage).text).toBe("one reply for both");
  });

  it("is idle again once every dispatch has resolved, and resolves pending ones on shutdown", async () => {
    const { bridge, settle } = await startBridge();
    const pending = bridge.sendAndWait(SCOPE, "alice", fromPerson("alice"));
    await settle();
    expect(bridge.isTurnRunning(SCOPE)).toBe(true);
    await bridge.shutdown();
    expect((await pending).text).toBe("Queue is shutting down.");
    expect(bridge.isTurnRunning(SCOPE)).toBe(false);
  });
});
