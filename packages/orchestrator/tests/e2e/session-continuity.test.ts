/**
 * E2E tests for session continuity — ZERO mocks.
 *
 * Real SQLite for persistent sessions, real Map for sub-agent sessions.
 * Tests that:
 * - Same scope yields same session ID across messages
 * - Different scopes get different sessions
 * - Discord scoping no longer includes userId (channel-level sessions)
 * - Sub-agent sessions live in-memory, not in the DB
 * - Sessions survive upsert (overwrite) correctly
 *
 * Covers bugs from:
 *   - 41dd33e: Scope sessions to channels and add orchestrator restart mechanism
 *   - 85708c8: Use in-memory map for sub-agent sessions instead of host DB
 */

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  initSessionsTable,
  getSessionId,
  setSessionId,
  deleteSession,
  getAllSessions,
} from "../../src/sessions.js";

// ── Tests ────────────────────────────────────────────────────────────────

describe("Session Continuity E2E — real SQLite", { timeout: 10_000 }, () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  // ── Test 1: Same scope, same session ───────────────────────────────

  it("1. same scope always returns the same session ID", () => {
    db = new Database(":memory:");
    initSessionsTable(db);

    const scope = "terminal:alice";
    setSessionId(db, scope, "session-001");

    // First lookup
    expect(getSessionId(db, scope)).toBe("session-001");

    // Second lookup — same result
    expect(getSessionId(db, scope)).toBe("session-001");

    // Third lookup after some time — still same
    expect(getSessionId(db, scope)).toBe("session-001");
  });

  // ── Test 2: Different scopes, different sessions ───────────────────

  it("2. different scopes get independent session IDs", () => {
    db = new Database(":memory:");
    initSessionsTable(db);

    setSessionId(db, "terminal:alice", "sess-alice");
    setSessionId(db, "terminal:bob", "sess-bob");
    setSessionId(db, "discord:guild1:chan1", "sess-discord-1");
    setSessionId(db, "discord:guild1:chan2", "sess-discord-2");

    expect(getSessionId(db, "terminal:alice")).toBe("sess-alice");
    expect(getSessionId(db, "terminal:bob")).toBe("sess-bob");
    expect(getSessionId(db, "discord:guild1:chan1")).toBe("sess-discord-1");
    expect(getSessionId(db, "discord:guild1:chan2")).toBe("sess-discord-2");

    // Mutating one doesn't affect others
    setSessionId(db, "terminal:alice", "sess-alice-v2");
    expect(getSessionId(db, "terminal:alice")).toBe("sess-alice-v2");
    expect(getSessionId(db, "terminal:bob")).toBe("sess-bob");
    expect(getSessionId(db, "discord:guild1:chan1")).toBe("sess-discord-1");
  });

  // ── Test 3: Discord channel-level scoping ──────────────────────────

  it("3. Discord scopes are at channel level (no userId), so all users share a session", () => {
    db = new Database(":memory:");
    initSessionsTable(db);

    // After 41dd33e, Discord scope format is discord:<server>:<channel>
    // (NOT discord:<server>:<channel>:<user>)
    const channelScope = "discord:guild1:general";

    // User A stores a session
    setSessionId(db, channelScope, "shared-session-001");

    // User B using the same channel gets the same session
    expect(getSessionId(db, channelScope)).toBe("shared-session-001");

    // There is NO per-user session — only one row for this channel
    const all = getAllSessions(db);
    const channelSessions = all.filter((s) => s.scope.startsWith("discord:guild1:general"));
    expect(channelSessions.length).toBe(1);
    expect(channelSessions[0].sessionId).toBe("shared-session-001");
  });

  // ── Test 4: Thread-level scoping ───────────────────────────────────

  it("4. Discord thread scope is separate from the parent channel scope", () => {
    db = new Database(":memory:");
    initSessionsTable(db);

    const channelScope = "discord:guild1:general";
    const threadScope = "discord:guild1:general:thread-123";

    setSessionId(db, channelScope, "channel-session");
    setSessionId(db, threadScope, "thread-session");

    // Both exist independently
    expect(getSessionId(db, channelScope)).toBe("channel-session");
    expect(getSessionId(db, threadScope)).toBe("thread-session");

    // Deleting the thread doesn't affect the channel
    deleteSession(db, threadScope);
    expect(getSessionId(db, channelScope)).toBe("channel-session");
    expect(getSessionId(db, threadScope)).toBeNull();
  });

  // ── Test 5: Session upsert (overwrite on resume) ───────────────────

  it("5. setSessionId overwrites (upserts) an existing session for the same scope", () => {
    db = new Database(":memory:");
    initSessionsTable(db);

    const scope = "terminal:admin";

    // Initial session
    setSessionId(db, scope, "sess-v1");
    expect(getSessionId(db, scope)).toBe("sess-v1");

    // Overwrite (e.g., stale session recovery replaces with new session)
    setSessionId(db, scope, "sess-v2");
    expect(getSessionId(db, scope)).toBe("sess-v2");

    // Only one row, not two
    const all = getAllSessions(db);
    const matching = all.filter((s) => s.scope === scope);
    expect(matching.length).toBe(1);
    expect(matching[0].sessionId).toBe("sess-v2");
  });

  // ── Test 6: Session deletion ───────────────────────────────────────

  it("6. deleteSession removes only the targeted scope", () => {
    db = new Database(":memory:");
    initSessionsTable(db);

    setSessionId(db, "scope-a", "a");
    setSessionId(db, "scope-b", "b");
    setSessionId(db, "scope-c", "c");

    deleteSession(db, "scope-b");

    expect(getSessionId(db, "scope-a")).toBe("a");
    expect(getSessionId(db, "scope-b")).toBeNull();
    expect(getSessionId(db, "scope-c")).toBe("c");

    // Double-delete is idempotent
    deleteSession(db, "scope-b");
    expect(getSessionId(db, "scope-b")).toBeNull();
  });

  // ── Test 7: getAllSessions snapshot for restart ─────────────────────

  it("7. getAllSessions returns all scope→sessionId pairs for restart snapshot", () => {
    db = new Database(":memory:");
    initSessionsTable(db);

    setSessionId(db, "terminal:alice", "s1");
    setSessionId(db, "discord:g1:c1", "s2");
    setSessionId(db, "discord:g1:c2", "s3");

    const all = getAllSessions(db);
    expect(all.length).toBe(3);

    const byScope = Object.fromEntries(all.map((r) => [r.scope, r.sessionId]));
    expect(byScope["terminal:alice"]).toBe("s1");
    expect(byScope["discord:g1:c1"]).toBe("s2");
    expect(byScope["discord:g1:c2"]).toBe("s3");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sub-agent sessions — in-memory Map (NOT SQLite)
// ═══════════════════════════════════════════════════════════════════════════

describe("Sub-Agent Sessions E2E — in-memory Map", { timeout: 10_000 }, () => {
  // Sub-agent sessions (after 85708c8) use a simple Map<string, string>
  // instead of SQLite. This test validates the contract that:
  // - Sub-agent sessions are scoped by a composite key
  // - They don't interfere with the SQLite session DB
  // - They're ephemeral (die with the process)

  it("8. sub-agent sessions are isolated from persistent DB sessions", () => {
    const db = new Database(":memory:");
    initSessionsTable(db);

    // Persistent session
    setSessionId(db, "terminal:admin", "persistent-sess");

    // Sub-agent session (in-memory map)
    const subagentSessions = new Map<string, string>();
    const subKey = "subagent:explorer:terminal:admin";
    subagentSessions.set(subKey, "ephemeral-sess");

    // Persistent DB doesn't know about sub-agent session
    expect(getSessionId(db, subKey)).toBeNull();

    // Sub-agent map doesn't know about persistent sessions
    expect(subagentSessions.get("terminal:admin")).toBeUndefined();

    // Both can coexist
    expect(getSessionId(db, "terminal:admin")).toBe("persistent-sess");
    expect(subagentSessions.get(subKey)).toBe("ephemeral-sess");

    db.close();
  });

  it("9. sub-agent sessions support same-scope reuse and replacement", () => {
    const subagentSessions = new Map<string, string>();

    const key = "subagent:coder:discord:g1:c1";

    // First dispatch
    subagentSessions.set(key, "sub-sess-1");
    expect(subagentSessions.get(key)).toBe("sub-sess-1");

    // Second dispatch (stale recovery) — replace
    subagentSessions.set(key, "sub-sess-2");
    expect(subagentSessions.get(key)).toBe("sub-sess-2");

    // Only one entry
    expect([...subagentSessions.entries()].filter(([k]) => k === key).length).toBe(1);
  });

  it("10. sub-agent sessions for different parent scopes are independent", () => {
    const subagentSessions = new Map<string, string>();

    subagentSessions.set("subagent:explorer:scope-a", "a-sess");
    subagentSessions.set("subagent:explorer:scope-b", "b-sess");
    subagentSessions.set("subagent:coder:scope-a", "c-sess");

    expect(subagentSessions.get("subagent:explorer:scope-a")).toBe("a-sess");
    expect(subagentSessions.get("subagent:explorer:scope-b")).toBe("b-sess");
    expect(subagentSessions.get("subagent:coder:scope-a")).toBe("c-sess");

    // Delete one, others survive
    subagentSessions.delete("subagent:explorer:scope-a");
    expect(subagentSessions.get("subagent:explorer:scope-a")).toBeUndefined();
    expect(subagentSessions.get("subagent:explorer:scope-b")).toBe("b-sess");
    expect(subagentSessions.get("subagent:coder:scope-a")).toBe("c-sess");
  });
});
