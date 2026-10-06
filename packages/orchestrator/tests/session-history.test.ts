import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initSessionsTable, setSessionId } from "../src/sessions.js";
import {
  initSessionHistoryTable,
  recordSessionHistory,
  SessionHistoryService,
  TranscriptIndex,
  type SessionsCaller,
} from "../src/session-history.js";

const GENERAL = "discord:1:100";
const THREAD = "discord:1:100:200";
const PRIVATE = "discord:1:300";

function line(e: Record<string, unknown>): string {
  return `${JSON.stringify(e)}\n`;
}
function user(text: string, ts: string, extra: Record<string, unknown> = {}): string {
  return line({ type: "user", timestamp: ts, message: { role: "user", content: text }, ...extra });
}
function assistant(text: string, ts: string): string {
  return line({
    type: "assistant", timestamp: ts,
    message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text }] },
  });
}

describe("session history", () => {
  let dir: string;
  let db: Database.Database;
  let index: TranscriptIndex;
  let service: SessionHistoryService;
  let projectDir: string;
  const blocked = new Set<string>();
  const caller: SessionsCaller = { agentId: "main", userId: "u1", userPlatform: "discord", scope: THREAD };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-history-"));
    projectDir = join(dir, "agents", "main", ".claude", "projects", "-workspace");
    mkdirSync(projectDir, { recursive: true });
    db = new Database(":memory:");
    initSessionsTable(db);
    initSessionHistoryTable(db);
    index = new TranscriptIndex(join(dir, "index.db"), join(dir, "agents"));
    blocked.clear();
    service = new SessionHistoryService({
      db,
      index,
      getCurrentSessionId: (scope) =>
        (db.prepare("SELECT session_id FROM sessions WHERE scope = ?").get(scope) as { session_id: string } | undefined)?.session_id ?? null,
      canView: async (_c, scope) => !blocked.has(scope),
      describe: async (scope) => ({ [GENERAL]: "#general", [THREAD]: 'thread "x" in #general', [PRIVATE]: "#private" })[scope] ?? scope,
    });

    writeFileSync(join(projectDir, "aaaa-1111.jsonl"),
      user("[sender: shitiz | discord id: u1]\nhow is the seedbox doing?", "2026-08-23T08:00:00Z") +
      line({ type: "ai-title", aiTitle: "Seedbox latency check" }) +
      assistant("Palawan latency is about 350ms via NTT transit.", "2026-08-23T08:01:00Z") +
      user("<command-name>/clear</command-name>", "2026-08-23T08:02:00Z") +
      user("meta", "2026-08-23T08:02:00Z", { isMeta: true }));
    writeFileSync(join(projectDir, "bbbb-2222.jsonl"),
      user("[sender: skye | discord id: u2]\nsecret plans for the party", "2026-09-01T10:00:00Z") +
      assistant("Noted the party plans.", "2026-09-01T10:00:30Z"));
    recordSessionHistory(db, GENERAL, "aaaa-1111", "main");
    recordSessionHistory(db, PRIVATE, "bbbb-2222", "main");
    setSessionId(db, GENERAL, "aaaa-1111");
  });

  afterEach(() => {
    db.close();
    index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("seeds history from the existing sessions table", () => {
    const db2 = new Database(":memory:");
    initSessionsTable(db2);
    setSessionId(db2, GENERAL, "old-session");
    initSessionHistoryTable(db2);
    const row = db2.prepare("SELECT scope FROM session_history WHERE session_id = ?").get("old-session") as { scope: string };
    expect(row.scope).toBe(GENERAL);
    db2.close();
  });

  it("lists visible sessions with title, location and current-session tag", async () => {
    const out = await service.list(caller, {});
    expect(out).toContain("2 session(s)");
    expect(out).toContain('aaaa-1111 | #general (current session there)');
    expect(out).toContain("Seedbox latency check");
    expect(out).toContain("2 msgs");
    // newest first
    expect(out.indexOf("bbbb-2222")).toBeLessThan(out.indexOf("aaaa-1111"));
  });

  it("hides sessions the caller cannot view", async () => {
    blocked.add(PRIVATE);
    expect(await service.list(caller, {})).not.toContain("bbbb-2222");
    expect(await service.search(caller, { query: "party" })).toBe('No matches for "party".');
    expect(await service.read(caller, { session_id: "bbbb-2222" })).toContain("not found");
  });

  it("filters by scope prefix, including threads under a channel", async () => {
    const out = await service.list(caller, { scope: GENERAL });
    expect(out).toContain("1 session(s) in #general (scope discord:1:100) and its threads.");
    expect(out).toContain("aaaa-1111");
    expect(out).not.toContain("bbbb-2222");
  });

  it("searches with stemming and returns snippets", async () => {
    const out = await service.search(caller, { query: "transits latency" });
    expect(out).toContain("aaaa-1111 #1");
    expect(out).toContain("**latency**");
    expect(await service.search(caller, { query: '"NTT transit" OR party' })).toContain("bbbb-2222");
  });

  it("leaves the caller's own conversation out of search results", async () => {
    const inGeneral: SessionsCaller = { ...caller, scope: GENERAL };
    expect(await service.search(inGeneral, { query: "latency" })).toBe('No matches for "latency".');
    expect(await service.search(caller, { query: "latency" })).toContain("aaaa-1111");
  });

  it("reads a session by unique prefix, skipping meta and command messages", async () => {
    const out = await service.read(caller, { session_id: "aaaa" });
    expect(out).toContain("Session aaaa-1111 — #general — 2 messages");
    expect(out).toContain("how is the seedbox doing?");
    expect(out).not.toContain("/clear");
    expect(out).not.toContain("meta");
  });

  it("indexes appended lines incrementally and strips the platform preamble from first_prompt", async () => {
    await index.refresh("main");
    appendFileSync(join(projectDir, "aaaa-1111.jsonl"), assistant("Follow-up: now 40ms after VFS caching.", "2026-08-24T09:00:00Z"));
    writeFileSync(join(projectDir, "cccc-3333.jsonl"),
      user("[platform: session start]\nNew session...\n[/platform]\n[sender: shitiz | discord id: u1]\ncompare hermes now", "2026-10-05T10:00:00Z"));
    recordSessionHistory(db, THREAD, "cccc-3333", "main");
    expect(await service.search(caller, { query: "VFS" })).toContain("aaaa-1111 #2");
    expect(index.getMeta("cccc-3333")?.first_prompt).toBe("compare hermes now");
    expect(await service.list(caller, {})).toContain("cccc-3333 | thread \"x\" in #general |");
    expect(service.scopeSessions(GENERAL, "main").map((s) => s.sessionId)).toEqual(["aaaa-1111"]);
  });

  it("keeps indexed sessions after the transcript file is pruned", async () => {
    await index.refresh("main");
    rmSync(join(projectDir, "aaaa-1111.jsonl"));
    expect(await service.read(caller, { session_id: "aaaa-1111" })).toContain("Palawan latency");
  });
});
