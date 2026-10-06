/**
 * Session history — every SDK session a scope has used, plus a full-text index
 * over agent transcripts so agents can look back at earlier conversations
 * (mcp__sessions__list / search / read).
 *
 * sessions.db `sessions` only maps scope → *current* session. `session_history`
 * keeps every session a scope has ever had. The transcript index
 * (session-index.db) holds the user/assistant text of each transcript, parsed
 * incrementally from the SDK's append-only JSONL files. Indexed rows are kept
 * after the SDK prunes old transcripts, so history outlives its cleanup window.
 */

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

// ── session_history table (lives in sessions.db) ──

export interface HistoryRow {
  session_id: string;
  scope: string;
  agent_id: string | null;
  first_seen: string;
  last_seen: string;
}

export function initSessionHistoryTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_history (
    session_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    agent_id TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_session_history_scope ON session_history(scope)");
  // Seed from the current scope → session mapping (idempotent).
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO session_history (session_id, scope, agent_id, first_seen, last_seen)
     SELECT session_id, scope, NULL, ?, ? FROM sessions`,
  ).run(now, now);
}

export function recordSessionHistory(
  db: Database.Database,
  scope: string,
  sessionId: string,
  agentId: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO session_history (session_id, scope, agent_id, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       last_seen = excluded.last_seen,
       agent_id = COALESCE(session_history.agent_id, excluded.agent_id)`,
  ).run(sessionId, scope, agentId, now, now);
}

function getHistoryRows(db: Database.Database): HistoryRow[] {
  return db.prepare("SELECT * FROM session_history").all() as HistoryRow[];
}

// ── Transcript index (session-index.db) ──

export interface TranscriptMeta {
  session_id: string;
  agent_id: string;
  path: string;
  indexed_bytes: number;
  first_ts: string | null;
  last_ts: string | null;
  msg_count: number;
  title: string | null;
  first_prompt: string | null;
}

export interface TranscriptMsg {
  seq: number;
  ts: string | null;
  role: string;
  text: string;
}

export interface SearchHit extends TranscriptMsg {
  session_id: string;
  snippet: string;
}

const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_STORED_TEXT = 16_000;
const SENDER_LINE = /^\[sender: [^\]\n]*\]\n?/;
/** Platform header + sender tag the orchestrator prepends to a session's first message. */
const MESSAGE_PREAMBLE = /^(?:\[platform: session start\][\s\S]*?\[\/platform\]\n?)?(?:\[sender: [^\]\n]*\]\n?)?/;

/** Extract the conversational text from one transcript entry (null = not a message). */
function extractMessage(e: any): { role: string; text: string } | null {
  if (!e || e.isSidechain) return null;
  if (e.type === "user") {
    if (e.isMeta) return null;
    const c = e.message?.content;
    const text = typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n")
        : "";
    if (!text.trim() || text.startsWith("<command-") || text.startsWith("<local-command")) return null;
    return { role: e.isCompactSummary ? "summary" : "user", text };
  }
  if (e.type === "assistant") {
    const c = e.message?.content;
    if (!Array.isArray(c)) return null;
    const text = c.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n");
    return text.trim() ? { role: "assistant", text } : null;
  }
  return null;
}

export class TranscriptIndex {
  private db: Database.Database;
  private inflight = new Map<string, Promise<void>>();

  constructor(dbPath: string, private agentsDir: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_files (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        path TEXT NOT NULL,
        indexed_bytes INTEGER NOT NULL DEFAULT 0,
        first_ts TEXT,
        last_ts TEXT,
        msg_count INTEGER NOT NULL DEFAULT 0,
        title TEXT,
        first_prompt TEXT
      );
      CREATE TABLE IF NOT EXISTS transcript_msgs (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_msgs_session ON transcript_msgs(session_id, seq);
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
        text, content='transcript_msgs', content_rowid='id', tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS transcript_msgs_ai AFTER INSERT ON transcript_msgs BEGIN
        INSERT INTO transcript_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS transcript_msgs_ad AFTER DELETE ON transcript_msgs BEGIN
        INSERT INTO transcript_fts(transcript_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
    `);
  }

  /** Bring the index up to date for one agent. Concurrent callers share one pass. */
  refresh(agentId: string): Promise<void> {
    const running = this.inflight.get(agentId);
    if (running) return running;
    const p = this.refreshAgent(agentId)
      .catch((err) => console.error(`[session-history] refresh ${agentId} failed:`, err))
      .finally(() => this.inflight.delete(agentId));
    this.inflight.set(agentId, p);
    return p;
  }

  private async refreshAgent(agentId: string): Promise<void> {
    const projectsDir = join(this.agentsDir, agentId, ".claude", "projects");
    if (!existsSync(projectsDir)) return;
    const getRow = this.db.prepare("SELECT * FROM transcript_files WHERE session_id = ?");
    for (const project of readdirSync(projectsDir)) {
      let names: string[];
      try { names = readdirSync(join(projectsDir, project)); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(projectsDir, project, name);
        let size: number;
        try { size = statSync(path).size; } catch { continue; }
        const sessionId = name.slice(0, -".jsonl".length);
        let row = getRow.get(sessionId) as TranscriptMeta | undefined;
        if (row && row.indexed_bytes === size) continue;
        if (row && size < row.indexed_bytes) {
          // Rewritten/truncated — rebuild this session from scratch.
          this.db.prepare("DELETE FROM transcript_msgs WHERE session_id = ?").run(sessionId);
          this.db.prepare("DELETE FROM transcript_files WHERE session_id = ?").run(sessionId);
          row = undefined;
        }
        await this.indexFile(agentId, sessionId, path, size, row);
      }
    }
  }

  private async indexFile(
    agentId: string,
    sessionId: string,
    path: string,
    size: number,
    prev: TranscriptMeta | undefined,
  ): Promise<void> {
    const meta: TranscriptMeta = prev ?? {
      session_id: sessionId, agent_id: agentId, path, indexed_bytes: 0,
      first_ts: null, last_ts: null, msg_count: 0, title: null, first_prompt: null,
    };
    meta.path = path;
    const insert = this.db.prepare(
      "INSERT INTO transcript_msgs (session_id, seq, ts, role, text) VALUES (?, ?, ?, ?, ?)",
    );
    const saveMeta = this.db.prepare(
      `INSERT OR REPLACE INTO transcript_files
       (session_id, agent_id, path, indexed_bytes, first_ts, last_ts, msg_count, title, first_prompt)
       VALUES (@session_id, @agent_id, @path, @indexed_bytes, @first_ts, @last_ts, @msg_count, @title, @first_prompt)`,
    );

    const fd = openSync(path, "r");
    try {
      let pos = meta.indexed_bytes;
      let carry = Buffer.alloc(0);
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(CHUNK_BYTES, size - pos));
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        pos += n;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        const lastNl = data.lastIndexOf(0x0a);
        if (lastNl < 0) { carry = data; continue; }
        carry = data.subarray(lastNl + 1);
        const lines = data.subarray(0, lastNl).toString("utf8").split("\n");

        this.db.transaction(() => {
          for (const line of lines) {
            if (!line) continue;
            let e: any;
            try { e = JSON.parse(line); } catch { continue; }
            if (e.type === "ai-title" && typeof e.aiTitle === "string") { meta.title = e.aiTitle; continue; }
            const msg = extractMessage(e);
            if (!msg) continue;
            const ts = typeof e.timestamp === "string" ? e.timestamp : null;
            if (ts) { meta.first_ts ??= ts; meta.last_ts = ts; }
            if (msg.role === "user" && !meta.first_prompt) {
              meta.first_prompt = msg.text.replace(MESSAGE_PREAMBLE, "").trim().slice(0, 300);
            }
            insert.run(sessionId, meta.msg_count++, ts, msg.role, msg.text.slice(0, MAX_STORED_TEXT));
          }
          meta.indexed_bytes = pos - carry.length;
          saveMeta.run(meta);
        })();
        // Yield between chunks so a large first-time index never stalls the event loop.
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      closeSync(fd);
    }
  }

  close(): void {
    this.db.close();
  }

  getMeta(sessionId: string): TranscriptMeta | undefined {
    return this.db.prepare("SELECT * FROM transcript_files WHERE session_id = ?").get(sessionId) as TranscriptMeta | undefined;
  }

  metaForAgent(agentId: string): Map<string, TranscriptMeta> {
    const rows = this.db.prepare("SELECT * FROM transcript_files WHERE agent_id = ?").all(agentId) as TranscriptMeta[];
    return new Map(rows.map((r) => [r.session_id, r]));
  }

  read(sessionId: string, start: number, limit: number): TranscriptMsg[] {
    return this.db.prepare(
      "SELECT seq, ts, role, text FROM transcript_msgs WHERE session_id = ? AND seq >= ? ORDER BY seq LIMIT ?",
    ).all(sessionId, start, limit) as TranscriptMsg[];
  }

  search(query: string, sessionIds: string[], limit: number): SearchHit[] {
    const run = (q: string) => this.db.prepare(
      `SELECT m.session_id, m.seq, m.ts, m.role, m.text,
              snippet(transcript_fts, 0, '**', '**', ' … ', 40) AS snippet
       FROM transcript_fts JOIN transcript_msgs m ON m.id = transcript_fts.rowid
       WHERE transcript_fts MATCH ? AND m.session_id IN (SELECT value FROM json_each(?))
       ORDER BY bm25(transcript_fts) LIMIT ?`,
    ).all(q, JSON.stringify(sessionIds), limit) as SearchHit[];
    // Plain words are ANDed. FTS5 syntax (quotes, OR, NEAR, prefix*) is honoured
    // when it parses; anything that doesn't falls back to the plain-word form.
    const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    const plain = words.map((w) => `"${w}"`).join(" ");
    const usesSyntax = /["*]|\b(OR|AND|NOT|NEAR)\b/.test(query);
    if (usesSyntax) {
      try { return run(query); } catch { /* fall through to plain words */ }
    }
    return plain ? run(plain) : [];
  }
}

// ── Service used by the callback API ──

export interface SessionsCaller {
  agentId: string;
  userId: string;
  userPlatform: string;
  /** Scope of the conversation making the call — marked "this conversation" in listings. */
  scope: string;
}

export interface SessionHistoryServiceDeps {
  db: Database.Database;
  index: TranscriptIndex;
  /** Current scope → session mapping (sessions table). */
  getCurrentSessionId: (scope: string) => string | null;
  /** May this user see the conversation held in `scope`? */
  canView: (caller: SessionsCaller, scope: string) => Promise<boolean>;
  /** Human-readable location for a scope, e.g. `thread "X" in #general`. */
  describe: (scope: string) => Promise<string>;
}

interface VisibleSession {
  row: HistoryRow;
  meta: TranscriptMeta;
  label: string;
}

/** Scopes that hold user conversations (not sub-agent / api / probe runs). */
function isConversationScope(scope: string): boolean {
  return (scope.startsWith("discord:") || scope.startsWith("terminal:")) && !scope.includes("#sched:");
}

function fmtTs(ts: string | null): string {
  return ts ? `${ts.slice(0, 16).replace("T", " ")}Z` : "?";
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export class SessionHistoryService {
  constructor(private deps: SessionHistoryServiceDeps) {}

  /** Sessions this caller may see, newest activity first. */
  private async visibleSessions(caller: SessionsCaller, scopeFilter?: string): Promise<VisibleSession[]> {
    await this.deps.index.refresh(caller.agentId);
    const metas = this.deps.index.metaForAgent(caller.agentId);
    const candidates = getHistoryRows(this.deps.db).filter((row) => {
      if (!metas.has(row.session_id) || !isConversationScope(row.scope)) return false;
      if (scopeFilter && row.scope !== scopeFilter && !row.scope.startsWith(`${scopeFilter}:`)) return false;
      return true;
    });

    const allowed = new Map<string, Promise<boolean>>();
    const labels = new Map<string, Promise<string>>();
    for (const { scope } of candidates) {
      if (!allowed.has(scope)) {
        allowed.set(scope, this.deps.canView(caller, scope).catch(() => false));
        labels.set(scope, this.deps.describe(scope).catch(() => scope));
      }
    }
    const out: VisibleSession[] = [];
    for (const row of candidates) {
      if (!(await allowed.get(row.scope))) continue;
      out.push({ row, meta: metas.get(row.session_id)!, label: await labels.get(row.scope)! });
    }
    out.sort((a, b) => (b.meta.last_ts ?? "").localeCompare(a.meta.last_ts ?? ""));
    return out;
  }

  private describeSession(s: VisibleSession, caller: SessionsCaller): string {
    const tags: string[] = [];
    if (s.row.scope === caller.scope && this.deps.getCurrentSessionId(caller.scope) === s.row.session_id) {
      tags.push("this conversation");
    } else if (this.deps.getCurrentSessionId(s.row.scope) === s.row.session_id) {
      tags.push("current session there");
    }
    const title = (s.meta.title ?? s.meta.first_prompt ?? "").replace(/\s+/g, " ").slice(0, 120);
    return `- ${s.row.session_id} | ${s.label}${tags.length ? ` (${tags.join(", ")})` : ""} | ` +
      `${fmtTs(s.meta.first_ts)} → ${fmtTs(s.meta.last_ts)} | ${s.meta.msg_count} msgs | ${title}`;
  }

  /** Echo of the scope filter, so the result shows it was applied. */
  private async filterLabel(scope?: string): Promise<string> {
    if (!scope) return "";
    const label = await this.deps.describe(scope).catch(() => scope);
    return ` in ${label} (scope ${scope}) and its threads`;
  }

  async list(caller: SessionsCaller, opts: { scope?: string; limit?: unknown }): Promise<string> {
    const limit = clampInt(opts.limit, 20, 1, 100);
    const sessions = await this.visibleSessions(caller, opts.scope || undefined);
    const where = await this.filterLabel(opts.scope);
    if (sessions.length === 0) return `No past sessions${where} that you can see.`;
    const lines = sessions.slice(0, limit).map((s) => this.describeSession(s, caller));
    return `${sessions.length} session(s)${where}${sessions.length > limit ? `, newest ${limit} shown` : ""}. ` +
      `Format: id | where | first → last activity (UTC) | messages | title\n${lines.join("\n")}`;
  }

  async search(caller: SessionsCaller, opts: { query?: string; scope?: string; limit?: unknown }): Promise<string> {
    const query = (opts.query ?? "").trim();
    if (!query) return "Error: query is required.";
    const limit = clampInt(opts.limit, 15, 1, 50);
    // Skip the conversation the caller is in: it is already in context, and the
    // question being asked would otherwise be the top hit.
    const self = this.deps.getCurrentSessionId(caller.scope);
    const sessions = (await this.visibleSessions(caller, opts.scope || undefined))
      .filter((s) => s.row.session_id !== self);
    const where = await this.filterLabel(opts.scope);
    if (sessions.length === 0) return `No past sessions${where} that you can see.`;
    const byId = new Map(sessions.map((s) => [s.row.session_id, s]));
    let hits: SearchHit[];
    try {
      hits = this.deps.index.search(query, [...byId.keys()], limit);
    } catch (err) {
      return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (hits.length === 0) return `No matches for "${query}"${where}.`;
    const lines = hits.map((h) => {
      const s = byId.get(h.session_id)!;
      const snippet = h.snippet.replace(SENDER_LINE, "").replace(/\s+/g, " ").trim();
      return `- ${h.session_id} #${h.seq} | ${s.label} | ${fmtTs(h.ts)} | ${h.role}: ${snippet}`;
    });
    return `${hits.length} match(es)${where}, best first. Format: session id #message | where | time (UTC) | role: snippet\n` +
      `${lines.join("\n")}\n\nRead around a match with mcp__sessions__read (session_id, start = message number minus a few).`;
  }

  async read(caller: SessionsCaller, opts: { session_id?: string; start?: unknown; limit?: unknown }): Promise<string> {
    const sessionId = (opts.session_id ?? "").trim();
    if (!sessionId) return "Error: session_id is required.";
    const sessions = await this.visibleSessions(caller);
    const matches = sessions.filter((v) => v.row.session_id.startsWith(sessionId));
    const s = matches.find((v) => v.row.session_id === sessionId) ?? (matches.length === 1 ? matches[0] : undefined);
    if (matches.length > 1 && !s) return `Session prefix ${sessionId} is ambiguous (${matches.length} matches) — use more characters.`;
    if (!s) return `Session ${sessionId} not found, or you don't have access to it.`;
    const fullId = s.row.session_id;
    const total = s.meta.msg_count;
    const limit = clampInt(opts.limit, 30, 1, 100);
    let start = clampInt(opts.start, -limit, -total || -1, Math.max(total - 1, 0));
    if (start < 0) start = Math.max(0, total + start);
    const msgs = this.deps.index.read(fullId, start, limit);
    const header = `Session ${fullId} — ${s.label} — ${total} messages, showing #${start}–#${start + msgs.length - 1}` +
      (start > 0 ? ` (earlier: start=${Math.max(0, start - limit)})` : "") +
      (start + msgs.length < total ? ` (later: start=${start + msgs.length})` : "");
    let budget = 80_000;
    const parts: string[] = [];
    for (const m of msgs) {
      let text = m.text.length > 4000 ? `${m.text.slice(0, 4000)}\n[… ${m.text.length - 4000} more chars]` : m.text;
      if (text.length > budget) text = `${text.slice(0, Math.max(0, budget))}\n[… output limit reached]`;
      parts.push(`--- #${m.seq} ${fmtTs(m.ts)} ${m.role} ---\n${text}`);
      budget -= text.length;
      if (budget <= 0) break;
    }
    return `${header}\n\n${parts.join("\n\n")}`;
  }

  /** Previous sessions of a scope, for the fresh-session header. No refresh (header must be fast). */
  scopeSessions(scope: string, agentId: string): { sessionId: string; firstTs: string | null; lastTs: string | null; title: string | null }[] {
    const metas = this.deps.index.metaForAgent(agentId);
    return getHistoryRows(this.deps.db)
      .filter((r) => r.scope === scope && metas.has(r.session_id))
      .map((r) => {
        const m = metas.get(r.session_id)!;
        return { sessionId: r.session_id, firstTs: m.first_ts, lastTs: m.last_ts, title: m.title ?? m.first_prompt };
      })
      .sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""));
  }
}
