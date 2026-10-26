import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  initScopeBindingsTable,
  bindScope,
  getScopeBinding,
  isBoundScope,
  unbindScope,
} from "../src/scope-bindings.js";

const APP = "app:shitiz:abc";
const PEER = "peer:def";

describe("scope bindings", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initScopeBindingsTable(db);
  });

  it("only app: and peer: scopes are bound scopes", () => {
    expect(isBoundScope(APP)).toBe(true);
    expect(isBoundScope(PEER)).toBe(true);
    expect(isBoundScope("discord:1:2")).toBe(false);
    expect(isBoundScope("terminal:s:alice")).toBe(false);
    expect(isBoundScope("api:kepler")).toBe(false);
  });

  it("stores and reads a binding", () => {
    const stored = bindScope(db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" }, "2026-10-26T00:00:00.000Z");
    expect(stored).toEqual({ scope: APP, agentId: "main", person: "shitiz", origin: "app", createdTs: "2026-10-26T00:00:00.000Z" });
    expect(getScopeBinding(db, APP)).toEqual(stored);
    expect(getScopeBinding(db, PEER)).toBeNull();
  });

  it("binding the same scope again identically is a no-op that keeps the first timestamp", () => {
    bindScope(db, { scope: PEER, agentId: "main", person: "shitiz", origin: "peer" }, "2026-10-26T00:00:00.000Z");
    const again = bindScope(db, { scope: PEER, agentId: "main", person: "shitiz", origin: "peer" }, "2026-10-27T00:00:00.000Z");
    expect(again.createdTs).toBe("2026-10-26T00:00:00.000Z");
  });

  it("never rebinds a scope to another agent, person or origin", () => {
    bindScope(db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    expect(() => bindScope(db, { scope: APP, agentId: "other", person: "shitiz", origin: "app" })).toThrow(/bound differently/);
    expect(() => bindScope(db, { scope: APP, agentId: "main", person: "urvashi", origin: "app" })).toThrow(/bound differently/);
    expect(() => bindScope(db, { scope: APP, agentId: "main", person: "shitiz", origin: "peer" })).toThrow(/bound differently/);
    expect(getScopeBinding(db, APP)?.person).toBe("shitiz");
  });

  it("refuses to bind scopes that config resolves", () => {
    expect(() => bindScope(db, { scope: "discord:1:2", agentId: "main", person: "shitiz", origin: "app" })).toThrow(/not a bound scope/);
  });

  it("forgets a binding on request (a refused peer start)", () => {
    bindScope(db, { scope: PEER, agentId: "main", person: "shitiz", origin: "peer" });
    expect(unbindScope(db, PEER)).toBe(true);
    expect(getScopeBinding(db, PEER)).toBeNull();
    expect(unbindScope(db, PEER)).toBe(false);
  });
});
