/**
 * Who has taken part in each scope (D3b §2). Written wherever Stockade knows the
 * authenticated person: a person's message (handleMessage), a peer message acting for a
 * person (platform "peer"), and later the controller routes (platform "app").
 *
 * Rows from the one-off backfill (`source = 'backfill'`) are parsed from the `[sender:`
 * lines in indexed transcripts. Lines from before 6cdbb8d weren't escaped, so they're
 * good but not proof; a live write for the same row upgrades it to `live`.
 */

import type Database from "better-sqlite3";

export type ParticipantSource = "live" | "backfill";

export interface Participant {
  scope: string;
  person: string;
  /** discord, terminal, app, or peer (acting for the person through another session). */
  platform: string;
  source: ParticipantSource;
  firstTs: string;
  lastTs: string;
}

export function initParticipantsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scope_participants (
    scope TEXT NOT NULL,
    person TEXT NOT NULL,
    platform TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'live',
    first_ts TEXT NOT NULL,
    last_ts TEXT NOT NULL,
    PRIMARY KEY (scope, person, platform)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_scope_participants_person ON scope_participants(person)");
}

/** Record that `person` took part in `scope` through `platform` at `ts` (default now). */
export function recordParticipant(
  db: Database.Database,
  scope: string,
  person: string,
  platform: string,
  source: ParticipantSource = "live",
  ts: string = new Date().toISOString(),
): void {
  db.prepare(
    `INSERT INTO scope_participants (scope, person, platform, source, first_ts, last_ts)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, person, platform) DO UPDATE SET
       first_ts = MIN(scope_participants.first_ts, excluded.first_ts),
       last_ts = MAX(scope_participants.last_ts, excluded.last_ts),
       source = CASE WHEN scope_participants.source = 'live' OR excluded.source = 'live' THEN 'live' ELSE 'backfill' END`,
  ).run(scope, person, platform, source, ts, ts);
}

interface ParticipantRow {
  scope: string;
  person: string;
  platform: string;
  source: ParticipantSource;
  first_ts: string;
  last_ts: string;
}

function toParticipant(row: ParticipantRow): Participant {
  return {
    scope: row.scope,
    person: row.person,
    platform: row.platform,
    source: row.source,
    firstTs: row.first_ts,
    lastTs: row.last_ts,
  };
}

/** Everyone who took part in a scope, earliest first (the first row is the starter). */
export function scopeParticipants(db: Database.Database, scope: string): Participant[] {
  const rows = db.prepare(
    "SELECT * FROM scope_participants WHERE scope = ? ORDER BY first_ts, person, platform",
  ).all(scope) as ParticipantRow[];
  return rows.map(toParticipant);
}

/** Every scope a person took part in, latest activity first. */
export function personParticipation(db: Database.Database, person: string): Participant[] {
  const rows = db.prepare(
    "SELECT * FROM scope_participants WHERE person = ? ORDER BY last_ts DESC",
  ).all(person) as ParticipantRow[];
  return rows.map(toParticipant);
}

// ── Backfill ─────────────────────────────────────────────────────────────────

/** Whether the backfill has written anything yet (it runs once, at the first start that has data). */
export function hasParticipantBackfill(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM scope_participants WHERE source = 'backfill' LIMIT 1").get();
}

/**
 * The person and platform a user message was stamped with, from its first `[sender:` or
 * `[peer:` line. Only the first stamped line counts: the platform writes it before the
 * person's own text, so a look-alike typed into the message (unescaped before 6cdbb8d)
 * comes later and is ignored. Escaped look-alikes (a zero-width space after the bracket) never match.
 */
export function parseStampedSender(text: string): { person: string; platform: string } | null {
  for (const line of text.split("\n")) {
    const sender = /^\[sender: ([^|\]]+?) \|(?:.*\|)? (\w+) id: [^|\]]+\]$/.exec(line);
    if (sender) {
      const person = sender[1].trim();
      return person === "unknown" ? null : { person, platform: sender[2] };
    }
    const peer = /^\[peer: from .* · on behalf of ([^·\]]+?) · host [^\]]*\]$/.exec(line);
    if (peer) return { person: peer[1].trim(), platform: "peer" };
  }
  return null;
}

export interface BackfillResult {
  /** User messages read from the index. */
  messages: number;
  /** Of those, messages with a stamped sender in a scope we know. */
  matched: number;
  /** scope_participants rows written or widened. */
  rows: number;
}

/**
 * One-off: fill scope_participants from the transcript index (session-index.db
 * `transcript_msgs`), mapping sessions to scopes through `session_history`.
 * Idempotent; never downgrades a live row.
 */
export function backfillParticipants(db: Database.Database, indexDb: Database.Database): BackfillResult {
  const scopeOf = new Map<string, string>();
  for (const row of db.prepare("SELECT session_id, scope FROM session_history").all() as Array<{ session_id: string; scope: string }>) {
    scopeOf.set(row.session_id, row.scope);
  }

  // Collapse to one (scope, person, platform) → [first, last] before writing.
  const spans = new Map<string, { scope: string; person: string; platform: string; first: string; last: string }>();
  let messages = 0;
  let matched = 0;
  const msgs = indexDb.prepare(
    "SELECT session_id, ts, text FROM transcript_msgs WHERE role = 'user' AND ts IS NOT NULL",
  ).iterate() as IterableIterator<{ session_id: string; ts: string; text: string }>;
  for (const msg of msgs) {
    messages++;
    const scope = scopeOf.get(msg.session_id);
    if (!scope) continue;
    const sender = parseStampedSender(msg.text);
    if (!sender) continue;
    matched++;
    const key = `${scope}\u0000${sender.person}\u0000${sender.platform}`;
    const span = spans.get(key);
    if (!span) {
      spans.set(key, { scope, ...sender, first: msg.ts, last: msg.ts });
    } else {
      if (msg.ts < span.first) span.first = msg.ts;
      if (msg.ts > span.last) span.last = msg.ts;
    }
  }

  const write = db.transaction(() => {
    for (const span of spans.values()) {
      recordParticipant(db, span.scope, span.person, span.platform, "backfill", span.first);
      recordParticipant(db, span.scope, span.person, span.platform, "backfill", span.last);
    }
  });
  write();
  return { messages, matched, rows: spans.size };
}
