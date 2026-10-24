/**
 * Sudo scopes: threads opened with /sudo, whose sessions run as the agent's
 * sudo user. A scope stops accepting messages after `idleMs` without one and
 * never becomes sudo again (start a new thread with /sudo).
 *
 * Persisted to a JSON file so a restart doesn't turn an open sudo thread into
 * an everyday one (or the reverse).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface SudoScope {
  openedBy: string;
  openedAt: number;
  lastActivity: number;
}

export type SudoState = "active" | "expired" | "none";

export class SudoRegistry {
  private scopes: Record<string, SudoScope> = {};

  constructor(private readonly file: string, readonly idleMs: number, private readonly now: () => number = Date.now) {
    if (existsSync(file)) {
      try { this.scopes = JSON.parse(readFileSync(file, "utf-8")) as Record<string, SudoScope>; } catch { /* start empty */ }
    }
  }

  open(scope: string, openedBy: string): void {
    const t = this.now();
    this.scopes[scope] = { openedBy, openedAt: t, lastActivity: t };
    this.save();
  }

  /** "none" for ordinary scopes; "expired" once idle too long (stays expired). */
  state(scope: string): SudoState {
    const s = this.scopes[scope];
    if (!s) return "none";
    return this.now() - s.lastActivity > this.idleMs ? "expired" : "active";
  }

  /** Record activity on an active sudo scope (extends its idle window). */
  touch(scope: string): void {
    const s = this.scopes[scope];
    if (!s || this.state(scope) !== "active") return;
    s.lastActivity = this.now();
    this.save();
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.scopes, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
