import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  initSessionsTable,
  getSessionId,
  setSessionId,
  deleteSession,
} from "../src/sessions.js";

describe("sessions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSessionsTable(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns null for unknown scope", () => {
    expect(getSessionId(db, "discord:111:222:333")).toBeNull();
  });

  it("stores and retrieves a session ID", () => {
    setSessionId(db, "discord:111:222:333", "sess-abc");
    expect(getSessionId(db, "discord:111:222:333")).toBe("sess-abc");
  });

  it("overwrites an existing session ID", () => {
    setSessionId(db, "discord:111:222:333", "sess-old");
    setSessionId(db, "discord:111:222:333", "sess-new");
    expect(getSessionId(db, "discord:111:222:333")).toBe("sess-new");
  });

  it("deletes a session", () => {
    setSessionId(db, "discord:111:222:333", "sess-abc");
    deleteSession(db, "discord:111:222:333");
    expect(getSessionId(db, "discord:111:222:333")).toBeNull();
  });

  it("delete is idempotent for non-existent scope", () => {
    // Should not throw
    deleteSession(db, "nonexistent:scope");
    expect(getSessionId(db, "nonexistent:scope")).toBeNull();
  });

  it("handles multiple independent scopes", () => {
    setSessionId(db, "discord:a:b:c", "sess-1");
    setSessionId(db, "discord:x:y:z", "sess-2");
    setSessionId(db, "terminal:local:uuid:user", "sess-3");

    expect(getSessionId(db, "discord:a:b:c")).toBe("sess-1");
    expect(getSessionId(db, "discord:x:y:z")).toBe("sess-2");
    expect(getSessionId(db, "terminal:local:uuid:user")).toBe("sess-3");
  });
});
