import type Database from "better-sqlite3";

/**
 * Ensure the sessions table exists. Call once at startup.
 */
export function initSessionsTable(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS sessions (scope TEXT PRIMARY KEY, session_id TEXT NOT NULL)"
  );
}

/**
 * Get the Agent SDK session ID for a given scope, or null if none exists.
 */
export function getSessionId(
  db: Database.Database,
  scope: string
): string | null {
  const row = db
    .prepare("SELECT session_id FROM sessions WHERE scope = ?")
    .get(scope) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

/**
 * Set (upsert) the Agent SDK session ID for a scope.
 */
export function setSessionId(
  db: Database.Database,
  scope: string,
  sessionId: string
): void {
  db.prepare(
    "INSERT INTO sessions (scope, session_id) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET session_id = excluded.session_id"
  ).run(scope, sessionId);
}

/**
 * Delete the session mapping for a scope.
 */
export function deleteSession(
  db: Database.Database,
  scope: string
): void {
  db.prepare("DELETE FROM sessions WHERE scope = ?").run(scope);
}
