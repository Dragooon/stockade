/**
 * What a paired controller app sees on Stockade (D3b, specs/d3b-client-spec.md): the
 * sessions, agents and live status for the one person its token is bound to (P). Every
 * answer is computed for P and bounded by what P can see. The HTTP surface is
 * api/controller-routes.ts.
 *
 * Listed (§3): scopes P has written in that P can still view; app:/peer: scopes bound to
 * P; and, when `peer_sessions` is on, scopes a peer message or a /dispatch acted for P in
 * (cross-agent sessions, including Kepler's api:kepler). Never: scheduler scopes and
 * throwaway api:<agent>:<uuid> runs.
 */

import { createHash } from "node:crypto";
import type { Participant } from "./participants.js";
import type { ScopeBinding } from "./scope-bindings.js";

export type ControllerSessionStatus = "busy" | "idle" | "closed";
export type ControllerOrigin = "discord" | "app" | "peer" | "terminal";
export type ControllerReadOnlyReason = "discord" | "terminal" | "agent";

export interface ControllerSession {
  /** First 12 hex of sha256(scope): the app's session id. */
  id: string;
  /** First 6 hex: the short ref agents use. */
  ref: string;
  scope: string;
  label: string;
  agentId: string | null;
  status: ControllerSessionStatus;
  /** Epoch ms of the latest activity Stockade knows of. */
  lastActive: number;
  sudo: boolean;
  /** The scope's current Claude session, so a client sees /new or a rotation. */
  claudeSessionId: string | null;
  origin: ControllerOrigin;
  startedBy: { kind: "person" | "agent"; name: string } | null;
  participants: Array<{ name: string; platform: string }>;
  writable: boolean;
  readOnlyReason: ControllerReadOnlyReason | null;
}

export interface ControllerAgent {
  id: string;
  name: string;
}

/** Capabilities the Stockade source advertises; grows as D3b units land (d3b-4/5/6/7). */
export const CONTROLLER_CAPABILITIES = ["list"] as const;

export type ControllerEvent =
  /** A visible session's state changed (turn started or ended, session opened or closed). */
  | { type: "session"; session: ControllerSession };

export interface ControllerDeps {
  /** P: the config username the token is bound to. */
  person: string;
  /** List cross-agent sessions acting for P (config `controller.peer_sessions`, default on). */
  peerSessions: boolean;
  /** Every participation row of P, latest first. */
  participation: (person: string) => Participant[];
  /** Every participation row of a scope, earliest first. */
  participants: (scope: string) => Participant[];
  /** app:/peer: scopes bound to P. */
  boundScopes: (person: string) => ScopeBinding[];
  binding: (scope: string) => ScopeBinding | null;
  /** Can P still view this Discord or terminal scope, talking to its agent? */
  canView: (scope: string, agentId: string) => Promise<boolean>;
  agentForScope: (scope: string) => string | null;
  describe: (scope: string) => Promise<string>;
  status: (scope: string) => ControllerSessionStatus;
  /** When the scope's last turn ended (epoch ms), if known since startup. */
  lastTurnEnded: (scope: string) => number | null;
  inSudo: (scope: string) => boolean;
  claudeSessionId: (scope: string) => string | null;
  /** Agents P may talk to, from config. */
  agents: () => ControllerAgent[];
  now: () => number;
}

const API_UUID_SCOPE = /^api:[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** P's own session, or one an agent acted for P in (listed only with peer_sessions). */
type Membership = "own" | "cross";

export function controllerSessionId(scope: string): string {
  return createHash("sha256").update(scope).digest("hex").slice(0, 12);
}

/** A participation row written by an agent acting for the person, not the person writing. */
function isAgentRow(row: Participant): boolean {
  return row.platform === "peer" || row.platform === "api";
}

export class ControllerService {
  private listeners = new Set<(event: ControllerEvent) => void>();

  constructor(private readonly deps: ControllerDeps) {}

  get person(): string {
    return this.deps.person;
  }

  /** Every session listed for P, latest activity first. */
  async sessions(): Promise<ControllerSession[]> {
    const scopes = new Set<string>();
    for (const row of this.deps.participation(this.deps.person)) scopes.add(row.scope);
    for (const binding of this.deps.boundScopes(this.deps.person)) scopes.add(binding.scope);
    const rows = await Promise.all([...scopes].map((scope) => this.row(scope)));
    return rows
      .filter((row): row is ControllerSession => row !== null)
      .sort((a, b) => b.lastActive - a.lastActive);
  }

  /** One listed session by its id, or null if P can't see it. */
  async find(id: string): Promise<ControllerSession | null> {
    return (await this.sessions()).find((session) => session.id === id) ?? null;
  }

  agents(): ControllerAgent[] {
    return this.deps.agents();
  }

  subscribe(listener: (event: ControllerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Something about a scope changed: tell subscribers, if P can see it. */
  async notify(scope: string): Promise<void> {
    if (this.listeners.size === 0) return;
    const session = await this.row(scope);
    if (!session) return;
    for (const listener of this.listeners) listener({ type: "session", session });
  }

  /** The session as P sees it, or null when it isn't listed for P. */
  private async row(scope: string): Promise<ControllerSession | null> {
    const membership = await this.membership(scope);
    if (!membership || (membership === "cross" && !this.deps.peerSessions)) return null;
    const label = await this.deps.describe(scope);
    // No awaits from here on: the state is read right before the row is returned, so when two
    // notifies for one scope race, the event emitted last carries the latest state.
    const binding = this.deps.binding(scope);
    const participants = this.deps.participants(scope);
    const status = this.deps.status(scope);
    const id = controllerSessionId(scope);
    const origin = originOf(scope);
    const writable = origin === "app" || (origin === "peer" && !scope.startsWith("api:"));
    // Busy: now. Otherwise when its last turn ended; after a restart, its latest participation
    // or binding time.
    const lastActive = status === "busy" ? this.deps.now() : Math.max(
      0,
      this.deps.lastTurnEnded(scope) ?? 0,
      ...participants.map((row) => Date.parse(row.lastTs) || 0),
      binding ? Date.parse(binding.createdTs) || 0 : 0,
    );
    return {
      id,
      ref: id.slice(0, 6),
      scope,
      label,
      agentId: this.deps.agentForScope(scope),
      status,
      lastActive,
      sudo: this.deps.inSudo(scope),
      claudeSessionId: this.deps.claudeSessionId(scope),
      origin,
      startedBy: startedBy(scope, binding, participants),
      participants: participants.map((row) => ({ name: row.person, platform: row.platform })),
      writable,
      readOnlyReason: writable ? null : readOnlyReason(scope),
    };
  }

  private async membership(scope: string): Promise<Membership | null> {
    if (scope.includes("#") || API_UUID_SCOPE.test(scope)) return null;
    const person = this.deps.person;
    const own = this.deps.participants(scope).filter((row) => row.person === person);
    const membership: Membership | null = own.some((row) => !isAgentRow(row)) ? "own" : own.length ? "cross" : null;
    if (scope.startsWith("app:") || scope.startsWith("peer:")) {
      // Bound scopes belong to one person (§3.2). An app: scope is P's own; a peer: scope
      // was started by an agent for P, so it's cross-agent until P writes in it.
      const binding = this.deps.binding(scope);
      if (binding?.person !== person) return null;
      return scope.startsWith("app:") ? "own" : membership ?? "cross";
    }
    if (scope.startsWith("api:")) {
      // Named /dispatch scopes (api:kepler): only ever acted in for P, never by P directly.
      return membership ? "cross" : null;
    }
    if (scope.startsWith("discord:") || scope.startsWith("terminal:")) {
      if (!membership) return null;
      const agentId = this.deps.agentForScope(scope);
      return agentId && (await this.deps.canView(scope, agentId)) ? membership : null;
    }
    return null;
  }
}

function originOf(scope: string): ControllerOrigin {
  if (scope.startsWith("discord:")) return "discord";
  if (scope.startsWith("app:")) return "app";
  if (scope.startsWith("terminal:")) return "terminal";
  return "peer"; // peer: and api: scopes: started by an agent
}

function readOnlyReason(scope: string): ControllerReadOnlyReason {
  if (scope.startsWith("discord:")) return "discord";
  if (scope.startsWith("terminal:")) return "terminal";
  return "agent";
}

function startedBy(
  scope: string,
  binding: ScopeBinding | null,
  participants: Participant[],
): ControllerSession["startedBy"] {
  if (binding) {
    if (binding.origin === "app") return { kind: "person", name: binding.person };
    if (binding.origin === "kepler") return { kind: "agent", name: "Kepler" };
    return { kind: "agent", name: "Agent" }; // d3b-8 records which agent started a peer: scope
  }
  if (scope === "api:kepler") return { kind: "agent", name: "Kepler" };
  const first = participants[0];
  if (!first) return null;
  return isAgentRow(first) ? { kind: "agent", name: "Agent" } : { kind: "person", name: first.person };
}
