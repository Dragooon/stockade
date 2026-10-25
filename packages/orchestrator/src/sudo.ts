/**
 * Sudo scopes: conversations (channel or thread scopes) switched into sudo mode with /sudo.
 * While a scope is active its sessions run as the agent's sudo user, in the same conversation.
 * It turns off with /sudo again or after `idleMs` without a message (the scope is then
 * "expired" until the orchestrator clears it and switches the conversation back).
 *
 * Persisted to a JSON file so a restart doesn't silently change a conversation's mode.
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

  /** Switch a scope into sudo mode. */
  open(scope: string, openedBy: string): void {
    const t = this.now();
    this.scopes[scope] = { openedBy, openedAt: t, lastActivity: t };
    this.save();
  }

  /** Switch a scope out of sudo mode (/sudo again). Returns false if it wasn't active. */
  end(scope: string): boolean {
    if (this.state(scope) !== "active") return false;
    this.clear(scope);
    return true;
  }

  /** "none" for everyday scopes; "expired" once idle too long (until cleared). */
  state(scope: string): SudoState {
    const s = this.scopes[scope];
    if (!s) return "none";
    return this.now() - s.lastActivity > this.idleMs ? "expired" : "active";
  }

  /** Forget a scope: it's an everyday scope again. */
  clear(scope: string): void {
    if (!(scope in this.scopes)) return;
    delete this.scopes[scope];
    this.save();
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
