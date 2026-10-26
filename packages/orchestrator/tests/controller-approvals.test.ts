import { describe, it, expect, vi, afterEach } from "vitest";
import { ControllerApprovals, type ApprovalHubEvent } from "../src/controller-approvals.js";
import type { ApprovalChannel } from "../src/types.js";

function hub(options: ConstructorParameters<typeof ControllerApprovals>[0] = {}) {
  let next = 0;
  const approvals = new ControllerApprovals({ newId: () => `a${++next}`, now: () => Date.parse("2026-10-26T12:00:00.000Z"), ...options });
  const events: ApprovalHubEvent[] = [];
  approvals.subscribe((event) => events.push(event));
  return { approvals, events };
}

describe("ControllerApprovals: app approvals", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for the app's decision and lists the approval until then", async () => {
    const { approvals, events } = hub();
    const asked = approvals.ask("app:shitiz:a1", "Bash", { command: "rm -rf build" }, { agentId: "main", review: { risk: "medium", summary: "deletes build" } });
    expect(approvals.list()).toEqual([{
      id: "a1",
      scope: "app:shitiz:a1",
      tool: "Bash",
      input: { command: "rm -rf build" },
      receivedAt: "2026-10-26T12:00:00.000Z",
      agentId: "main",
      review: { risk: "medium", summary: "deletes build" },
      answerIn: null,
    }]);
    expect(approvals.decide("a1", "allow")).toBe("decided");
    expect(await asked).toBe(true);
    expect(approvals.list()).toEqual([]);
    expect(events.map((e) => [e.type, e.approval.id, e.type === "decision" ? e.behaviour : null]))
      .toEqual([["approval", "a1", null], ["decision", "a1", "allow"]]);
  });

  it("a deny resolves false, and a second decision finds nothing", async () => {
    const { approvals } = hub();
    const asked = approvals.ask("peer:p1", "Write", {});
    expect(approvals.decide("a1", "deny")).toBe("decided");
    expect(await asked).toBe(false);
    expect(approvals.decide("a1", "allow")).toBe("not_found");
    expect(approvals.decide("nope", "allow")).toBe("not_found");
  });

  it("denies at the timeout and says so", async () => {
    vi.useFakeTimers();
    const { approvals, events } = hub({ timeoutMs: 1000 });
    const asked = approvals.ask("app:shitiz:a1", "Bash", {});
    vi.advanceTimersByTime(1000);
    expect(await asked).toBe(false);
    expect(approvals.list()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "decision", behaviour: "deny" });
  });

  it("channel(scope) asks in that scope and passes the review and agent", async () => {
    const { approvals } = hub();
    const asked = approvals.channel("app:shitiz:a1").askUser("Bash", { command: "ls" }, { risk: "high", summary: "s" }, "main");
    expect(approvals.get("a1")).toMatchObject({ scope: "app:shitiz:a1", agentId: "main", review: { risk: "high" } });
    approvals.decide("a1", "allow");
    expect(await asked).toBe(true);
  });

  it("a throwing listener doesn't stop the others", async () => {
    const { approvals, events } = hub();
    approvals.subscribe(() => { throw new Error("boom"); });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    void approvals.ask("app:shitiz:a1", "Bash", {});
    approvals.decide("a1", "deny");
    expect(events.map((e) => e.type)).toEqual(["approval", "decision"]);
    spy.mockRestore();
  });
});

describe("ControllerApprovals: mirrored channel approvals", () => {
  function channel() {
    let answer!: (approved: boolean) => void;
    const inner: ApprovalChannel = {
      askUser: vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; })),
      notifyAutoApproved: vi.fn(async () => {}),
      askQuestions: vi.fn(async () => ({})),
    };
    return { inner, answer: (approved: boolean) => answer(approved) };
  }

  it("shows the approval read-only until the channel answers, and returns the channel's answer", async () => {
    const { approvals, events } = hub();
    const { inner, answer } = channel();
    const mirrored = approvals.mirror(inner, "discord:g:general", "discord");
    const asked = mirrored.askUser("Bash", { command: "ls" }, undefined, "main");
    expect(approvals.get("a1")).toMatchObject({ scope: "discord:g:general", answerIn: "discord" });
    expect(approvals.decide("a1", "allow")).toBe("read_only");
    answer(true);
    expect(await asked).toBe(true);
    expect(approvals.list()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "decision", behaviour: "allow" });
    expect(inner.askUser).toHaveBeenCalledWith("Bash", { command: "ls" }, undefined, "main");
  });

  it("settles as deny when the channel throws, and keeps the channel's other callbacks", async () => {
    const { approvals, events } = hub();
    const inner: ApprovalChannel = {
      askUser: async () => { throw new Error("discord down"); },
      notifyAutoApproved: vi.fn(async () => {}),
      askQuestions: vi.fn(async () => ({})),
    };
    const mirrored = approvals.mirror(inner, "terminal:shitiz", "terminal");
    await expect(mirrored.askUser("Bash", {})).rejects.toThrow("discord down");
    expect(approvals.list()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "decision", behaviour: "deny" });
    expect(mirrored.notifyAutoApproved).toBe(inner.notifyAutoApproved);
    expect(mirrored.askQuestions).toBe(inner.askQuestions);
  });
});
