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
});
