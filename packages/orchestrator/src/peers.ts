/**
 * Peers: session-to-session messaging (mcp__peers__list / mcp__peers__send).
 *
 * Modelled on Claude Code's own agent messaging: a session lists the other sessions
 * its person can see, sends one plain-text message, and the receiver replies (or not)
 * with a send of its own. There is no automatic reply and no shared history.
 *
 * Everything that touches the rest of the orchestrator comes in through PeerDeps, so
 * the routing, visibility and guard rules here are testable on their own. Sessions on
 * other machines can join later as another PeerProvider.
 *
 * Spec: specs/SPEC-PEERS.md.
 */

import { createHash } from "node:crypto";
import type { ChannelResponse } from "./types.js";
import { isConversationScope } from "./scope-bindings.js";

// ── Limits ───────────────────────────────────────────────────────────────────

export const PEER_MAX_MESSAGE_CHARS = 8_000;
export const PEER_HOP_LIMIT = 6;
export const PEER_RATE_LIMIT = 20;
export const PEER_RATE_WINDOW_MS = 10 * 60_000;
/** Closed sessions stay listed (and reachable: Stockade resumes them by scope) this long. */
export const PEER_CLOSED_LISTING_MS = 14 * 24 * 3_600_000;
export const PEER_LIST_CAP = 50;
/** An api: scope can be replied to this long after it last messaged a session. */
export const PEER_API_REPLY_WINDOW_MS = 24 * 3_600_000;
/** How much of the message the target's channel sees above the reply. */
export const PEER_PREVIEW_CHARS = 300;

export const NOT_FOUND = "no visible session matches";
export const SUDO_TARGET = "target is in sudo mode; only sudo sessions can message it";

// ── Scope predicates ─────────────────────────────────────────────────────────

// The only scopes peers lists (shared with session history).
export { isConversationScope };

const API_UUID_SCOPE = /^api:[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sessions offered the peers tools: conversations, named API conversations (they
 * may send as their acting person) and scheduled runs. Not throwaway `api:<agent>:<uuid>`
 * runs and not sub-agents, which keep mcp__agent__message.
 */
export function canUsePeers(scope: string): boolean {
  if (scope.startsWith("subagent:") || scope.startsWith("self-spawn:")) return false;
  if (API_UUID_SCOPE.test(scope)) return false;
  return isConversationScope(scope) || scope.startsWith("api:") || scope.startsWith("#sched:");
}

/** Stable short id for a scope that reveals nothing about it. */
export function peerRef(scope: string): string {
  return createHash("sha256").update(scope).digest("hex").slice(0, 6);
}

/**
 * Neutralise text that could pass for a platform-stamped line or wrapper. Only the
 * orchestrator writes `[peer:`, `[sender:`, `[platform:` and the message wrapper.
 */
export function escapePeerText(text: string): string {
  return text
    .replace(/\[(peer|sender|platform):/gi, (_m, word: string) => `[​${word}:`)
    .replace(/<(\/?)cross-session-message/gi, (_m, slash: string) => `<​${slash}cross-session-message`);
}

/**
 * A session label as it may appear in stamped text. Labels come from channel and thread
 * names, which any Discord member can set, so they lose everything that could close the
 * header, open a fake one, start a new line or add a field: brackets and angle brackets
 * become look-alikes, line breaks and invisible characters go, middle dots (the header's
 * field separator) become hyphens, and double quotes become single ones, so the label
 * in `from="…"` is the same label `mcp__peers__send` resolves. `@everyone`/`@here` get a
 * full-width at sign so a post can't ping. Idempotent.
 */
export function sanitizePeerLabel(label: string): string {
  const clean = label
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/[\[［⟦〚]/g, "(")
    .replace(/[\]］⟧〛]/g, ")")
    .replace(/[<＜〈⟨]/g, "‹")
    .replace(/[>＞〉⟩]/g, "›")
    .replace(/[·•∙⋅・･]/g, "-")
    .replace(/["“”＂]/g, "'")
    .replace(/@(everyone|here)/gi, "＠$1")
    .replace(/\s+/g, " ")
    .trim();
  return clean || "unnamed session";
}

// ── Types ────────────────────────────────────────────────────────────────────

/** The session calling a peers tool, and the person its current turn runs for. */
export interface PeerCaller {
  scope: string;
  agentId: string;
  userId: string;
  userPlatform: string;
  /** Peer hops behind the current turn (0 for a turn a person started). */
  hops: number;
}

export type PeerStatus = "busy" | "idle" | "closed";

export interface PeerEntry {
  scope: string;
  ref: string;
  label: string;
  agentId: string;
  status: PeerStatus;
  /** ms since epoch, or null if unknown. */
  lastActive: number | null;
  sudo: boolean;
  /** Set for sessions on another machine (a later RemotePeerProvider). */
  host?: string;
}

export interface PeerDeliveryMeta {
  agentId: string;
  userId: string;
  userPlatform: string;
  hops: number;
  /** The sender's session runs as root. Only then may the message land in a sudo-mode scope. */
  fromSudo: boolean;
}

/** Everything peers needs from the orchestrator. */
export interface PeerDeps {
  /** Every scope with a stored or live session. */
  knownScopes(): string[];
  /** The agent a scope's conversation runs (null if none resolves). */
  agentForScope(scope: string): string | null;
  /** May this person read the conversation in `scope` (run by `agentId`)? */
  canView(viewer: { agentId: string; userId: string; userPlatform: string }, scope: string): Promise<boolean>;
  describe(scope: string): Promise<string>;
  status(scope: string): PeerStatus;
  lastActive(scope: string, agentId: string): number | null;
  /** Is the scope in sudo mode? An expired one isn't (its state is cleared). The list's `sudo` tag and the send guard. */
  inSudo(scope: string): boolean;
  /** Does the scope's open session run as root (a sudo session)? The sender side of the sudo guard. */
  runsAsRoot(scope: string): boolean;
  /** Display name for the person (RBAC username), or null for nobody. */
  personName(userId: string, userPlatform: string): string | null;
  /** Would a message for this person join or start a turn now ("delivered"), or wait ("queued")? */
  deliveryState(scope: string, meta: PeerDeliveryMeta): "delivered" | "queued";
  /** Hand the wrapped message to the target's session. Resolves with the turn's result. */
  deliver(scope: string, text: string, meta: PeerDeliveryMeta): Promise<ChannelResponse>;
  /** Post into a scope's own chat channel (no-op for scopes without one). */
  post(scope: string, text: string): Promise<void>;
  hostName: string;
  now(): number;
}

/** A source of peer sessions. The local one lives here; a remote one can be added later. */
export interface PeerProvider {
  list(caller: PeerCaller): Promise<PeerEntry[]>;
  send(entry: PeerEntry, wrapped: string, from: PeerCaller): Promise<"delivered" | "queued">;
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatRelative(ms: number | null, now: number): string {
  if (ms === null) return "unknown";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const entryName = (e: { label: string; ref: string }) => `${e.label} [${e.ref}]`;

// ── Service ──────────────────────────────────────────────────────────────────

export class PeerService implements PeerProvider {
  /** sender scope → send timestamps inside the rate window. */
  private readonly sends = new Map<string, number[]>();
  /** receiving scope → (api: scope → when it last messaged the receiver, and its agent). */
  private readonly apiInbound = new Map<string, Map<string, { at: number; agentId: string }>>();
  private readonly providers: PeerProvider[];

  constructor(private readonly deps: PeerDeps, remoteProviders: PeerProvider[] = []) {
    this.providers = [this, ...remoteProviders];
  }

  /** Local provider: the caller's person's visible conversations, newest first. */
  async list(caller: PeerCaller): Promise<PeerEntry[]> {
    const now = this.deps.now();
    const entries: PeerEntry[] = [];
    for (const scope of new Set(this.deps.knownScopes())) {
      if (scope === caller.scope || !isConversationScope(scope)) continue;
      const agentId = this.deps.agentForScope(scope);
      if (!agentId) continue;
      const status = this.deps.status(scope);
      const lastActive = this.deps.lastActive(scope, agentId);
      if (status === "closed" && (lastActive === null || now - lastActive > PEER_CLOSED_LISTING_MS)) continue;
      if (!(await this.deps.canView({ agentId, userId: caller.userId, userPlatform: caller.userPlatform }, scope))) continue;
      entries.push({
        scope,
        ref: peerRef(scope),
        label: await this.labelFor(scope),
        agentId,
        status,
        lastActive,
        sudo: this.deps.inSudo(scope),
      });
    }
    return entries;
  }

  async send(entry: PeerEntry, wrapped: string, from: PeerCaller): Promise<"delivered" | "queued"> {
    const meta: PeerDeliveryMeta = {
      agentId: entry.agentId,
      userId: from.userId,
      userPlatform: from.userPlatform,
      hops: from.hops + 1,
      fromSudo: this.deps.runsAsRoot(from.scope),
    };
    const state = this.deps.deliveryState(entry.scope, meta);
    const person = this.deps.personName(from.userId, from.userPlatform) ?? from.userId;
    const fromLabel = await this.labelFor(from.scope);
    this.deps.deliver(entry.scope, wrapped, meta).then(async (result) => {
      // The receiver's reply belongs to its own conversation. Empty means it was coalesced
      // into a reply some other message is posting; silent means mcp__agent__no_reply.
      if (result.silent || !result.text.trim()) return;
      const preview = this.extractBody(wrapped).slice(0, PEER_PREVIEW_CHARS);
      await this.deps.post(entry.scope, `*Message from ${fromLabel} on behalf of ${person}:* ${preview}\n\n${result.text}`);
    }).catch((err) => {
      console.error(`[peers] delivery to ${entry.scope.slice(0, 40)} failed:`, err instanceof Error ? err.message : err);
    });
    return state;
  }

  /** All providers' entries for the caller, newest first, capped. */
  async visible(caller: PeerCaller): Promise<PeerEntry[]> {
    const all = (await Promise.all(this.providers.map((p) => p.list(caller)))).flat();
    // Other hosts' labels are as untrusted as Discord's.
    return all
      .map((e) => ({ ...e, label: sanitizePeerLabel(e.label), ...(e.host !== undefined && { host: sanitizePeerLabel(e.host) }) }))
      .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
      .slice(0, PEER_LIST_CAP);
  }

  // ── Tool entry points ──

  async listTool(caller: PeerCaller): Promise<string> {
    const self = await this.labelFor(caller.scope);
    const entries = await this.visible(caller);
    const now = this.deps.now();
    const lines = entries.map((e) =>
      `  ${entryName(e)}  ·  ${e.agentId}  ·  ${e.status}  ·  last active ${formatRelative(e.lastActive, now)}` +
      `${e.sudo ? "  ·  sudo" : ""}${e.host ? `  ·  ${e.host}` : ""}`,
    );
    return [`This session is ${self} [${peerRef(caller.scope)}].`, `Peer sessions (${entries.length}):`, ...lines].join("\n");
  }

  async sendTool(caller: PeerCaller, to: unknown, message: unknown): Promise<string> {
    if (typeof to !== "string" || !to.trim()) return "Error: `to` is required";
    if (typeof message !== "string" || !message.trim()) return "Error: `message` is required";
    if (message.length > PEER_MAX_MESSAGE_CHARS) return `Error: message is longer than ${PEER_MAX_MESSAGE_CHARS} characters`;

    const person = this.deps.personName(caller.userId, caller.userPlatform);
    if (!person) return "Error: this session has no person behind it, so it can't send";
    if (caller.hops + 1 > PEER_HOP_LIMIT) return "Error: hop limit";

    const target = await this.resolve(caller, to.trim());
    if (typeof target === "string") return `Error: ${target}`;
    if (target.scope === caller.scope) return "Error: can't send to this session itself";

    // Visibility is checked again at send time, not only when listing.
    if (!target.scope.startsWith("api:") && !target.host) {
      const agentId = this.deps.agentForScope(target.scope);
      if (!agentId || !(await this.deps.canView({ agentId, userId: caller.userId, userPlatform: caller.userPlatform }, target.scope))) {
        return `Error: ${NOT_FOUND}`;
      }
    }
    // Sudo sessions can message anywhere their person can see; only sudo sessions can message a
    // scope in sudo mode, since the message would run there as root (Shitiz, 2026-10-26).
    if (!target.host && this.deps.inSudo(target.scope) && !this.deps.runsAsRoot(caller.scope)) {
      return `Error: ${SUDO_TARGET}`;
    }
    if (!this.takeRateSlot(caller.scope)) return `Error: rate limit (${PEER_RATE_LIMIT} sends per ${PEER_RATE_WINDOW_MS / 60_000} minutes)`;

    const wrapped = await this.wrap(caller, message);
    if (caller.scope.startsWith("api:")) {
      const inbound = this.apiInbound.get(target.scope) ?? new Map<string, { at: number; agentId: string }>();
      inbound.set(caller.scope, { at: this.deps.now(), agentId: caller.agentId });
      this.apiInbound.set(target.scope, inbound);
    }
    const provider = target.host ? this.providers.find((p) => p !== this) : this;
    if (!provider) return `Error: ${NOT_FOUND}`;
    const state = await provider.send(target, wrapped, caller);
    return `${state}: ${entryName(target)}${state === "queued" ? " (it's busy with someone else's turn; your message starts its own turn when that ends)" : ""}`;
  }

  // ── Internals ──

  /** The wrapped, orchestrator-stamped message the target sees. */
  async wrap(caller: PeerCaller, message: string): Promise<string> {
    const from = `${await this.labelFor(caller.scope)} [${peerRef(caller.scope)}]`;
    const person = this.deps.personName(caller.userId, caller.userPlatform) ?? caller.userId;
    const noReply = caller.scope.startsWith("#sched:") ? " · no reply possible" : "";
    return [
      `[peer: from ${from} · agent ${caller.agentId} · on behalf of ${person} · host ${this.deps.hostName}${noReply}]`,
      `<cross-session-message from="${from.replace(/"/g, "'")}">`,
      escapePeerText(message),
      `</cross-session-message>`,
    ].join("\n");
  }

  private extractBody(wrapped: string): string {
    const lines = wrapped.split("\n");
    return lines.slice(2, -1).join("\n").replace(/​/g, "");
  }

  private async labelFor(scope: string): Promise<string> {
    if (scope.startsWith("#sched:")) return sanitizePeerLabel(`scheduled task ${scope.split(":")[1] ?? ""}`);
    return sanitizePeerLabel(await this.deps.describe(scope));
  }

  /** `to` may be a ref, a unique label, or the full `label [ref]` form. */
  private async resolve(caller: PeerCaller, to: string): Promise<PeerEntry | string> {
    const full = to.match(/^(.*)\s\[([0-9a-f]{6})\]$/i);
    const refOnly = /^\[?([0-9a-f]{6})\]?$/i.exec(to);
    const wantRef = (full?.[2] ?? refOnly?.[1])?.toLowerCase();
    const wantLabel = full ? full[1].trim() : refOnly ? null : to;

    const candidates = [...(await this.visible(caller)), ...(await this.replyableApiScopes(caller))];
    if (wantRef) {
      const match = candidates.find((e) => e.ref === wantRef && (wantLabel === null || e.label === wantLabel));
      if (match) return match;
      if (wantRef === peerRef(caller.scope)) return "can't send to this session itself";
      return NOT_FOUND;
    }
    const matches = candidates.filter((e) => e.label === wantLabel);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      return `more than one session is called that; use one of:\n${matches.map((e) => `  ${entryName(e)}`).join("\n")}`;
    }
    if (wantLabel === (await this.labelFor(caller.scope))) return "can't send to this session itself";
    return NOT_FOUND;
  }

  /** api: scopes that messaged the caller's session in the last 24 h: reachable by reply only. */
  private async replyableApiScopes(caller: PeerCaller): Promise<PeerEntry[]> {
    const inbound = this.apiInbound.get(caller.scope);
    if (!inbound) return [];
    const now = this.deps.now();
    const out: PeerEntry[] = [];
    for (const [scope, { at, agentId }] of inbound) {
      if (now - at > PEER_API_REPLY_WINDOW_MS) { inbound.delete(scope); continue; }
      out.push({ scope, ref: peerRef(scope), label: await this.labelFor(scope), agentId, status: this.deps.status(scope), lastActive: at, sudo: false });
    }
    return out;
  }

  private takeRateSlot(senderScope: string): boolean {
    const now = this.deps.now();
    const recent = (this.sends.get(senderScope) ?? []).filter((t) => now - t < PEER_RATE_WINDOW_MS);
    if (recent.length >= PEER_RATE_LIMIT) {
      this.sends.set(senderScope, recent);
      return false;
    }
    recent.push(now);
    this.sends.set(senderScope, recent);
    return true;
  }
}
