/**
 * Pairings for peer principals (D3b §10): a principal such as Kepler may message one
 * target session only once its person has allowed that pairing.
 *
 * - A pairing is (principal, target scope).
 * - Allow lasts until the pairing has been idle for PAIRING_IDLE_MS, or until it's revoked.
 * - Deny refuses the pair for PAIRING_DENY_MS.
 * - Pre-approved pairs (config) are always allowed.
 *
 * Decisions are stored, so they survive a restart. A pairing being asked about right now
 * lives only in memory: a restart forgets it, and the next message asks again.
 */

import type Database from "better-sqlite3";

export const PAIRING_IDLE_MS = 3_600_000;
export const PAIRING_DENY_MS = 24 * 3_600_000;

export type PairingState =
  | { kind: "allowed" }
  | { kind: "denied"; until: number }
  | { kind: "pending" }
  | { kind: "new" };

/** What PeerService needs from the pairing store. */
export interface PairingStore {
  state(principal: string, scope: string): PairingState;
  /** Mark the pair as being asked about, so further messages wait. */
  begin(principal: string, scope: string): void;
  /** Record the person's answer (and end the pending mark). */
  decide(principal: string, scope: string, allowed: boolean): void;
  /** End the pending mark without an answer (nowhere to ask, or the ask failed). */
  cancel(principal: string, scope: string): void;
  /** The pair was used: its idle clock starts again. */
  touch(principal: string, scope: string): void;
}

interface Row { state: "allow" | "deny"; decided_ts: number; last_used_ts: number }

export class PeerPairings implements PairingStore {
  private readonly pending = new Set<string>();

  constructor(
    private readonly db: Database.Database,
    private readonly preApproved: Record<string, string[]> = {},
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS peer_pairings (
      principal TEXT NOT NULL,
      scope TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('allow', 'deny')),
      decided_ts INTEGER NOT NULL,
      last_used_ts INTEGER NOT NULL,
      PRIMARY KEY (principal, scope)
    )`);
  }

  state(principal: string, scope: string): PairingState {
    if (this.preApproved[principal]?.includes(scope)) return { kind: "allowed" };
    if (this.pending.has(key(principal, scope))) return { kind: "pending" };
    const row = this.row(principal, scope);
    const now = this.now();
    if (row?.state === "allow" && now - row.last_used_ts < PAIRING_IDLE_MS) return { kind: "allowed" };
    if (row?.state === "deny" && now - row.decided_ts < PAIRING_DENY_MS) return { kind: "denied", until: row.decided_ts + PAIRING_DENY_MS };
    return { kind: "new" };
  }

  begin(principal: string, scope: string): void {
    this.pending.add(key(principal, scope));
  }

  decide(principal: string, scope: string, allowed: boolean): void {
    this.pending.delete(key(principal, scope));
    const now = this.now();
    this.db.prepare(
      `INSERT INTO peer_pairings (principal, scope, state, decided_ts, last_used_ts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(principal, scope) DO UPDATE SET state = excluded.state, decided_ts = excluded.decided_ts, last_used_ts = excluded.last_used_ts`,
    ).run(principal, scope, allowed ? "allow" : "deny", now, now);
  }

  cancel(principal: string, scope: string): void {
    this.pending.delete(key(principal, scope));
  }

  touch(principal: string, scope: string): void {
    this.db.prepare(`UPDATE peer_pairings SET last_used_ts = ? WHERE principal = ? AND scope = ? AND state = 'allow'`)
      .run(this.now(), principal, scope);
  }

  /** Withdraw an allow (or lift a deny) early; false if there was nothing stored. */
  revoke(principal: string, scope: string): boolean {
    return this.db.prepare(`DELETE FROM peer_pairings WHERE principal = ? AND scope = ?`).run(principal, scope).changes > 0;
  }

  private row(principal: string, scope: string): Row | undefined {
    return this.db.prepare(`SELECT state, decided_ts, last_used_ts FROM peer_pairings WHERE principal = ? AND scope = ?`)
      .get(principal, scope) as Row | undefined;
  }
}

const key = (principal: string, scope: string) => `${principal}\u0000${scope}`;
