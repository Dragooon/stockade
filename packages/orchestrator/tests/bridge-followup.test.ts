import { describe, it, expect, vi } from "vitest";

// Keep the test's lines out of the live dispatch.log.
vi.mock("../src/log.js", () => ({ appendLog: () => {} }));

const { OrchestratorBridge } = await import("../src/bus/orchestrator-bridge.js");

async function startBridge() {
  let onEvent!: (scope: string, event: any) => void;
  const bus = {
    subscribeAllEvents: async (cb: typeof onEvent) => { onEvent = cb; },
    subscribeWorkerLifecycle: async () => {},
    startListening: () => {},
  };
  const bridge = new OrchestratorBridge(bus as any, {} as any);
  await bridge.start();
  const delivered: Array<[string, string]> = [];
  bridge.onFollowup((scope, r) => delivered.push([scope, r.text]));
  return { delivered, onEvent };
}

const result = (text: string, extra: Record<string, unknown> = {}) => ({
  kind: "evt:result", scope: "discord:g:c", correlationId: "followup:1", text,
  sdkSessionId: "s", stopReason: "end_turn", timestamp: "", ...extra,
});

describe("OrchestratorBridge follow-ups", () => {
  it("posts a follow-up result to the channel", async () => {
    const { delivered, onEvent } = await startBridge();
    onEvent("discord:g:c", result("Shortlist: 3 lots", { followup: true }));
    expect(delivered).toEqual([["discord:g:c", "Shortlist: 3 lots"]]);
  });

  it("posts nothing for an empty or silent follow-up, or a stray result that isn't one", async () => {
    const { delivered, onEvent } = await startBridge();
    onEvent("discord:g:c", result("", { followup: true }));
    onEvent("discord:g:c", result("", { followup: true, silent: true }));
    onEvent("discord:g:c", result("no pending for this one"));
    expect(delivered).toEqual([]);
  });

  describe("/sudo switch", () => {
    async function startWithSession() {
      let onEvent!: (scope: string, event: any) => void;
      const published: any[] = [];
      let open = true;
      const bus = {
        subscribeAllEvents: async (cb: typeof onEvent) => { onEvent = cb; },
        subscribeWorkerLifecycle: async () => {},
        startListening: () => {},
        publishMessage: async (message: any) => { published.push(message); },
      };
      const sessionManager = {
        ensureSession: async () => { open = true; return { agentId: "main", agentCwd: "/", sandboxed: false }; },
        closeSession: async () => { open = false; },
        get: () => (open ? {} : undefined),
        touch: () => {},
      };
      const bridge = new OrchestratorBridge(bus as any, sessionManager as any);
      await bridge.start();
      const delivered: string[] = [];
      bridge.onFollowup((_scope, r) => delivered.push(r.text));
      return { bridge, published, delivered, onEvent: (scope: string, event: any) => onEvent(scope, event) };
    }
    const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("settles a cut-off message so the scope isn't busy, and sends it again in the new session", async () => {
      const { bridge, published, delivered, onEvent } = await startWithSession();
      const reply = bridge.sendAndWait("app:a", "[platform: sudo mode ON, x]\n[sender: a]\nhello", {});
      await nextTick();
      expect(bridge.isTurnRunning("app:a")).toBe(true);

      await bridge.closeSession("app:a", "sudo_off");
      expect(await reply).toMatchObject({ text: "" });
      await nextTick();
      expect(bridge.isTurnRunning("app:a")).toBe(false);
      expect(bridge.hasInterrupted("app:a")).toBe(true);

      bridge.resumeInterrupted("app:a", false, "[platform: sudo mode OFF.]");
      await nextTick();
      expect(published[1].text).toBe("[sender: a]\nhello\n\n[platform: sudo mode OFF.]");
      expect(bridge.hasInterrupted("app:a")).toBe(false);

      onEvent("app:a", { ...result("Hi"), scope: "app:a", correlationId: published[1].correlationId });
      await nextTick();
      expect(delivered).toEqual(["Hi"]);
    });

    it("puts a cut-off message first in the next one", async () => {
      const { bridge, published } = await startWithSession();
      void bridge.sendAndWait("app:a", "[sender: a]\nfirst", {});
      await nextTick();
      await bridge.closeSession("app:a", "sudo_on");
      void bridge.sendAndWait("app:a", "[sender: a]\nsecond", {});
      await nextTick();
      expect(published[1].text).toBe("[sender: a]\nfirst\n\n[sender: a]\nsecond");
    });

    it("tells a peer its everyday turn was cut off by a switch to root, and never moves its text there", async () => {
      const { bridge, published } = await startWithSession();
      const reply = bridge.sendAndWait("app:a", "[platform: sudo mode is on here]\n[peer: from x]\n<cross-session-message from=\"x\">\nhi\n</cross-session-message>", {});
      await nextTick();
      await bridge.closeSession("app:a", "sudo_on");
      expect((await reply).dropped).toMatch(/cut its turn off/);
      expect(bridge.hasInterrupted("app:a")).toBe(false);
      void bridge.sendAndWait("app:a", "[sender: a]\nroot", { sudo: true });
      await nextTick();
      expect(published[1].text).toBe("[sender: a]\nroot");
    });

    it("keeps a peer's text when a session switches to everyday", async () => {
      const { bridge } = await startWithSession();
      void bridge.sendAndWait("app:a", "[peer: from x]\nhi", {});
      await nextTick();
      await bridge.closeSession("app:a", "sudo_off");
      expect(bridge.hasInterrupted("app:a")).toBe(true);
    });

    it("counts a background task as running work until it ends", async () => {
      const { bridge, published, onEvent } = await startWithSession();
      void bridge.sendAndWait("app:a", "hello", {});
      await nextTick();
      onEvent("app:a", { kind: "evt:tasks", scope: "app:a", correlationId: "c", live: 1, timestamp: "" });
      onEvent("app:a", { ...result("Done"), scope: "app:a", correlationId: published[0].correlationId });
      await nextTick();
      expect(bridge.isTurnRunning("app:a")).toBe(false);
      expect(bridge.hasRunningWork("app:a")).toBe(true);
      onEvent("app:a", { kind: "evt:tasks", scope: "app:a", correlationId: "c", live: 0, timestamp: "" });
      expect(bridge.hasRunningWork("app:a")).toBe(false);
    });

    it("leaves other closes alone", async () => {
      const { bridge } = await startWithSession();
      void bridge.sendAndWait("app:a", "hello", {});
      await nextTick();
      await bridge.closeSession("app:a", "subagent_done");
      expect(bridge.hasInterrupted("app:a")).toBe(false);
    });
  });

  it("shows busy during a turn nobody is waiting on, until its result", async () => {
    let onEvent!: (scope: string, event: any) => void;
    const bus = { subscribeAllEvents: async (cb: typeof onEvent) => { onEvent = cb; }, subscribeWorkerLifecycle: async () => {}, startListening: () => {} };
    const bridge = new OrchestratorBridge(bus as any, { touch: () => {}, get: () => ({}) } as any);
    await bridge.start();
    bridge.onFollowup(() => {});
    onEvent("app:a", { kind: "evt:turn", scope: "app:a", correlationId: "x", turns: 1, input: 1, output: 1, cacheRead: 0, cacheCreate: 0 });
    expect(bridge.isTurnRunning("app:a")).toBe(true);
    expect(bridge.busyScopes()).toEqual(["app:a"]);
    onEvent("app:a", { ...result("done", { followup: true }), scope: "app:a" });
    expect(bridge.isTurnRunning("app:a")).toBe(false);
  });
});
