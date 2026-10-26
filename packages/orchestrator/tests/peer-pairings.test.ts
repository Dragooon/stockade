import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { PeerPairings, PAIRING_IDLE_MS, PAIRING_DENY_MS } from "../src/peer-pairings.js";

function store(preApproved: Record<string, string[]> = {}) {
  let now = 1_800_000_000_000;
  const db = new Database(":memory:");
  const pairings = new PeerPairings(db, preApproved, () => now);
  return { pairings, db, advance: (ms: number) => { now += ms; } };
}

describe("PeerPairings", () => {
  it("is new until asked, pending while asked, then allowed until idle for an hour", () => {
    const { pairings, advance } = store();
    expect(pairings.state("kepler", "discord:g:1")).toEqual({ kind: "new" });
    pairings.begin("kepler", "discord:g:1");
    expect(pairings.state("kepler", "discord:g:1")).toEqual({ kind: "pending" });
    pairings.decide("kepler", "discord:g:1", true);
    expect(pairings.state("kepler", "discord:g:1")).toEqual({ kind: "allowed" });
    advance(PAIRING_IDLE_MS - 1);
    pairings.touch("kepler", "discord:g:1");
    advance(PAIRING_IDLE_MS - 1);
    expect(pairings.state("kepler", "discord:g:1")).toEqual({ kind: "allowed" });
    advance(1);
    expect(pairings.state("kepler", "discord:g:1")).toEqual({ kind: "new" });
  });

  it("refuses a denied pair for 24 hours, and touching doesn't extend a deny", () => {
    const { pairings, advance } = store();
    const start = 1_800_000_000_000;
    pairings.begin("kepler", "app:shitiz:a");
    pairings.decide("kepler", "app:shitiz:a", false);
    advance(PAIRING_DENY_MS - 1);
    pairings.touch("kepler", "app:shitiz:a");
    expect(pairings.state("kepler", "app:shitiz:a")).toEqual({ kind: "denied", until: start + PAIRING_DENY_MS });
    advance(1);
    expect(pairings.state("kepler", "app:shitiz:a")).toEqual({ kind: "new" });
  });

  it("keeps pairs apart per principal and per session", () => {
    const { pairings } = store();
    pairings.decide("kepler", "discord:g:1", true);
    expect(pairings.state("kepler", "discord:g:2")).toEqual({ kind: "new" });
    expect(pairings.state("other", "discord:g:1")).toEqual({ kind: "new" });
  });

  it("treats pre-approved pairs as allowed, always", () => {
    const { pairings, advance } = store({ kepler: ["discord:g:dev"] });
    advance(10 * PAIRING_DENY_MS);
    expect(pairings.state("kepler", "discord:g:dev")).toEqual({ kind: "allowed" });
    expect(pairings.state("other", "discord:g:dev")).toEqual({ kind: "new" });
  });

  it("cancel ends a pending ask without a decision; revoke forgets one", () => {
    const { pairings } = store();
    pairings.begin("kepler", "discord:g:1");
    pairings.cancel("kepler", "discord:g:1");
    expect(pairings.state("kepler", "discord:g:1")).toEqual({ kind: "new" });
    pairings.decide("kepler", "discord:g:1", true);
    expect(pairings.revoke("kepler", "discord:g:1")).toBe(true);
    expect(pairings.revoke("kepler", "discord:g:1")).toBe(false);
    expect(pairings.state("kepler", "discord:g:1")).toEqual({ kind: "new" });
  });

  it("decisions survive a new store on the same database (a restart); pending ones don't", () => {
    const { pairings, db } = store();
    pairings.decide("kepler", "discord:g:1", true);
    pairings.begin("kepler", "discord:g:2");
    const again = new PeerPairings(db, {}, () => 1_800_000_000_000);
    expect(again.state("kepler", "discord:g:1")).toEqual({ kind: "allowed" });
    expect(again.state("kepler", "discord:g:2")).toEqual({ kind: "new" });
  });
});
