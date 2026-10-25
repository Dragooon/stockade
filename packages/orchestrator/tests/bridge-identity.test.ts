import { describe, it, expect, vi } from "vitest";

// Keep the test's lines out of the live dispatch.log.
vi.mock("../src/log.js", () => ({ appendLog: () => {} }));

const { OrchestratorBridge } = await import("../src/bus/orchestrator-bridge.js");

const SCOPE = "discord:g:c";

/** A bridge over a fake bus and session manager that records what reaches the worker. */
async function startBridge() {
  let onEvent!: (scope: string, event: any) => void;
  const published: Array<{ correlationId: string; text: string; userId: string }> = [];
  const ensureCalls: Array<{ userId: string; turnRunning: boolean }> = [];
  const bus = {
    subscribeAllEvents: async (callback: typeof onEvent) => { onEvent = callback; },
    subscribeWorkerLifecycle: async () => {},
    startListening: () => {},
    publishMessage: async (message: any) => { published.push(message); },
    shutdown: async () => {},
  };
  const sessionManager = {
    ensureSession: async (_scope: string, meta: any, opts?: { turnRunning?: boolean }) => {
      ensureCalls.push({ userId: meta.userId, turnRunning: !!opts?.turnRunning });
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

describe("OrchestratorBridge: identity is fixed for a whole turn", () => {
  it("lets the same person's follow-up join the running turn without re-applying identity", async () => {
    const { bridge, published, ensureCalls, settle, finishTurn } = await startBridge();
    const first = bridge.sendAndWait(SCOPE, "do the thing", fromPerson("alice"));
    await settle();
    const second = bridge.sendAndWait(SCOPE, "and this too", fromPerson("alice"));
    await settle();

    expect(published.map((m) => m.text)).toEqual(["do the thing", "and this too"]);
    expect(ensureCalls).toEqual([
      { userId: "alice", turnRunning: false },
      { userId: "alice", turnRunning: true },
    ]);

    finishTurn(published[0].correlationId, "done");
    expect((await first).text).toBe("done");
    expect((await second).text).toBe(""); // coalesced into the one reply
  });

  it("holds another person's message until the running turn ends, then starts a turn as them", async () => {
    const { bridge, published, ensureCalls, settle, finishTurn } = await startBridge();
    const aliceTurn = bridge.sendAndWait(SCOPE, "alice asks", fromPerson("alice"));
    await settle();
    const bobMessage = bridge.sendAndWait(SCOPE, "bob asks", fromPerson("bob"));
    await settle();

    // Bob's text never reaches the worker during Alice's turn.
    expect(published.map((m) => m.text)).toEqual(["alice asks"]);
    expect(ensureCalls).toEqual([{ userId: "alice", turnRunning: false }]);

    finishTurn(published[0].correlationId, "for alice");
    expect((await aliceTurn).text).toBe("for alice");
    await settle();

    expect(published.map((m) => m.text)).toEqual(["alice asks", "bob asks"]);
    expect(ensureCalls[1]).toEqual({ userId: "bob", turnRunning: false });

    finishTurn(published[1].correlationId, "for bob");
    expect((await bobMessage).text).toBe("for bob");
  });

  it("releases held messages in order, batching each person's run into one turn", async () => {
    const { bridge, published, ensureCalls, settle, finishTurn } = await startBridge();
    void bridge.sendAndWait(SCOPE, "alice 1", fromPerson("alice"));
    await settle();
    void bridge.sendAndWait(SCOPE, "bob 1", fromPerson("bob"));
    void bridge.sendAndWait(SCOPE, "carol 1", fromPerson("carol"));
    void bridge.sendAndWait(SCOPE, "bob 2", fromPerson("bob"));
    await settle();

    finishTurn(published[0].correlationId, "a");
    await settle();
    expect(published.map((m) => m.text)).toEqual(["alice 1", "bob 1", "bob 2"]);
    expect(ensureCalls.slice(1)).toEqual([
      { userId: "bob", turnRunning: false },
      { userId: "bob", turnRunning: true },
    ]);

    finishTurn(published[1].correlationId, "b");
    await settle();
    expect(published.map((m) => m.text)).toEqual(["alice 1", "bob 1", "bob 2", "carol 1"]);
    expect(ensureCalls.at(-1)).toEqual({ userId: "carol", turnRunning: false });
  });

  it("two near-simultaneous first messages from different people don't both start the turn", async () => {
    const { bridge, published, ensureCalls, settle } = await startBridge();
    void bridge.sendAndWait(SCOPE, "alice", fromPerson("alice"));
    void bridge.sendAndWait(SCOPE, "bob", fromPerson("bob"));
    await settle();
    expect(published.map((m) => m.text)).toEqual(["alice"]);
    expect(ensureCalls).toEqual([{ userId: "alice", turnRunning: false }]);
  });

  it("resolves held messages on shutdown", async () => {
    const { bridge, settle } = await startBridge();
    void bridge.sendAndWait(SCOPE, "alice", fromPerson("alice"));
    await settle();
    const held = bridge.sendAndWait(SCOPE, "bob", fromPerson("bob"));
    await settle();
    await bridge.shutdown();
    expect((await held).text).toBe("Queue is shutting down.");
  });
});
