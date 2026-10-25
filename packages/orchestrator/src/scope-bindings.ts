/**
 * Scopes outside the config bindings (D3b §6): `app:` sessions started from the
 * controller app and `peer:` sessions started by agents. Config only knows Discord and
 * terminal scopes, so the agent, the person the scope belongs to and its origin are
 * stored when the scope is created, before its first session, and survive /new.
 */

import type Database from "better-sqlite3";

/** Prefixes of scopes whose agent and owner come from scope_bindings, not config. */
export const BOUND_SCOPE_PREFIXES = ["app:", "peer:"] as const;

export function isBoundScope(scope: string): boolean {
  return BOUND_SCOPE_PREFIXES.some((prefix) => scope.startsWith(prefix));
}

export interface ScopeBinding {
  scope: string;
  agentId: string;
  /** The person the scope belongs to: the only one who sees it and may write in it. */
  person: string;
  /** Who started it: `app` (the person, from the app), `peer` (an agent acting for the person), `kepler` (Kepler, for the person). */
  origin: string;
  createdTs: string;
}

export function initScopeBindingsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scope_bindings (
    scope TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    person TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_ts TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_scope_bindings_person ON scope_bindings(person)");
}

/**
 * Bind a new scope. A binding never changes once written: binding the same scope again
 * with the same agent, person and origin is a no-op, anything else throws.
 */
export function bindScope(
  db: Database.Database,
  binding: { scope: string; agentId: string; person: string; origin: string },
  ts: string = new Date().toISOString(),
): ScopeBinding {
  if (!isBoundScope(binding.scope)) {
    throw new Error(`not a bound scope: ${binding.scope.slice(0, 60)}`);
  }
  db.prepare(
    `INSERT INTO scope_bindings (scope, agent_id, person, origin, created_ts)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope) DO NOTHING`,
  ).run(binding.scope, binding.agentId, binding.person, binding.origin, ts);
  const stored = getScopeBinding(db, binding.scope)!;
  if (stored.agentId !== binding.agentId || stored.person !== binding.person || stored.origin !== binding.origin) {
    throw new Error(`scope already bound differently: ${binding.scope.slice(0, 60)}`);
  }
  return stored;
}

interface ScopeBindingRow {
  scope: string;
  agent_id: string;
  person: string;
  origin: string;
  created_ts: string;
}

function toBinding(row: ScopeBindingRow): ScopeBinding {
  return { scope: row.scope, agentId: row.agent_id, person: row.person, origin: row.origin, createdTs: row.created_ts };
}

export function getScopeBinding(db: Database.Database, scope: string): ScopeBinding | null {
  const row = db.prepare("SELECT * FROM scope_bindings WHERE scope = ?").get(scope) as ScopeBindingRow | undefined;
  return row ? toBinding(row) : null;
}

/** Every scope bound to a person, newest first. */
export function scopesBoundTo(db: Database.Database, person: string): ScopeBinding[] {
  const rows = db.prepare("SELECT * FROM scope_bindings WHERE person = ? ORDER BY created_ts DESC").all(person) as ScopeBindingRow[];
  return rows.map(toBinding);
}

/**
 * A conversation people or agents talk in: a Discord channel or thread (including its
 * `:agent:<id>` sub-scopes), a terminal session, or an `app:` / `peer:` scope. Shared by
 * peers (what it lists) and session history (what it searches). Never `api:`, scheduled
 * (`#sched:`) or sub-agent scopes.
 */
export function isConversationScope(scope: string): boolean {
  if (scope.includes("#")) return false;
  if (scope.startsWith("discord:")) return scope.split(":").length >= 3;
  return scope.startsWith("terminal:") || isBoundScope(scope);
}
