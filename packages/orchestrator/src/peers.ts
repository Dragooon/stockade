/**
 * Peers: session-to-session messaging (mcp__peers__list / mcp__peers__send), and fresh
 * sessions an agent starts for its person (mcp__peers__start, D3b §8).
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
import type { ApprovalDecision, ChannelResponse } from "./types.js";
import { isConversationScope } from "./scope-bindings.js";
import type { PairingStore } from "./peer-pairings.js";

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
/** Fresh sessions one sending scope may start per window (D3b §8). */
export const PEER_START_LIMIT = 5;
export const PEER_START_WINDOW_MS = 3_600_000;
/** How much of the message the target's channel sees above the reply. */
export const PEER_PREVIEW_CHARS = 300;

export const NOT_FOUND = "no visible session matches";
export const SUDO_TARGET = "target is in sudo mode; only sudo sessions can message it";
export const REMOTE_START = "no peer host is called that";
/** Longest notice another controller may send about a conversation (D4). */
export const PEER_NOTICE_MAX_CHARS = 2_000;
/** A session ref: this host's, or another controller's as its daemon reports it. */
const REF = /^[0-9a-f]{6}$/;
/** The pairing "scope" for fresh starts from a remote session: one allow covers its starts for the idle hour. */
const START_PAIRING = "#start";
/** A conversation's id in the app: stable for the pairing, opaque. */
const conversationId = (principal: string, scope: string) =>
  createHash("sha256").update(`${principal}\u0000${scope}`).digest("hex").slice(0, 16);
/** Messages kept for a principal until it fetches them. */
export const PEER_INBOX_CAP = 200;

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

/**
 * An agent outside Stockade with an identity of its own (D3b §10), e.g. Kepler. It acts as its
 * RBAC user, sees what the person it works for sees, needs that person's approval for each
 * session it messages, starts sessions bound to that person, and is never in sudo mode.
 */
export interface PeerPrincipal {
  /** RBAC username, e.g. "kepler". */
  name: string;
  /** Shown as the sender, e.g. "Kepler". */
  label: string;
  /** The machine it runs on, e.g. "MacBook". */
  host: string;
  /** The person it works for (RBAC username): its visible set, approver and the owner of what it starts. */
  forPerson: string;
  /** forPerson's identity, for visibility checks. */
  viewer: { userId: string; userPlatform: string };
  /** Agent its starts run when it names none (none: it must name one). */
  defaultAgent?: string;
}

/** The session calling a peers tool, and the person its current turn runs for. */
export interface PeerCaller {
  /** For a principal, `principal:<name>`: a key for limits and replies, not a session. */
  scope: string;
  agentId: string;
  userId: string;
  userPlatform: string;
  /** Peer hops behind the current turn (0 for a turn a person started). */
  hops: number;
  /** Set when a principal calls (over its own token), not a Stockade session. */
  principal?: PeerPrincipal;
  /** Set for a session on another controller writing in (D4): its turn runs as the daemon's person. */
  remote?: RemoteSender;
  /** A notice turn from another controller: a failure isn't reported back (notices never answer notices). */
  notice?: boolean;
}

/** A session on another controller (D4), as that controller's daemon describes it. */
export interface RemoteSender {
  /** The other controller's host id, e.g. "mac". */
  host: string;
  /** Shown as its host, e.g. "MacBook". */
  hostLabel: string;
  ref: string;
  label: string;
  agent: string;
}

/** Something waiting for a principal: a message sent to it, or the outcome of a held message. */
export interface PeerInboxItem {
  at: string;
  kind: "message" | "notice";
  /** message: the sender's "label [ref]", what mcp__peers__send takes to reply. */
  from?: string;
  agent?: string;
  onBehalfOf?: string;
  text: string;
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
  /** Set for sessions on another controller: the host's label, e.g. "MacBook". */
  host?: string;
  /** Another controller's sessions: its host id and their own ref there. Sends go through its daemon. */
  remoteHost?: string;
  remoteRef?: string;
  /** Set for a principal reachable by reply: sends go to its inbox. */
  principal?: string;
}

export interface PeerDeliveryMeta {
  agentId: string;
  userId: string;
  userPlatform: string;
  hops: number;
  /** The sender's session runs as root. Only then may the message land in a sudo-mode scope. */
  fromSudo: boolean;
  /** The sender is a principal (by name): it participates as itself, platform api. */
  principal?: string;
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
  /** May this person run this agent (RBAC checkAccess)? Unknown agents are false. Needed by start. */
  canUseAgent?(userId: string, userPlatform: string, agentId: string): boolean;
  /** Create and bind a fresh `peer:<id>` scope for this agent and person, with this origin. Needed by start. */
  createPeerScope?(agentId: string, person: string, origin: "peer" | string): string;
  /** Principals (D3b §10): stored pairing decisions. Without it principals can't send. */
  pairings?: PairingStore;
  /**
   * Ask the principal's person whether it may message this session (a `peer_conversation`
   * approval in the target's channel or the app). Only "deny" is stored (refused for 24 h);
   * "unanswered" leaves no record. null when there's nowhere to ask.
   */
  askPairing?(principal: PeerPrincipal, target: PeerEntry, preview: string, request?: string): Promise<ApprovalDecision | null>;
  /** Undo createPeerScope for a fresh start that was refused before anything ran in it. */
  dropPeerScope?(scope: string): void;
  /** A configured principal by name (null once it's gone from config). Needed by conversations. */
  principal?(name: string): PeerPrincipal | null;
  hostName: string;
  now(): number;
}

/** A source of peer sessions on this host. */
export interface PeerProvider {
  list(caller: PeerCaller): Promise<PeerEntry[]>;
  send(entry: PeerEntry, wrapped: string, from: PeerCaller): Promise<"delivered" | "queued">;
}

/** Another controller's answer (D4 peer API). */
export type RemoteStatus = "delivered" | "queued" | "awaiting_approval" | "started" | "refused";
export interface RemoteResult {
  status: RemoteStatus;
  reason?: string;
  /** started / awaiting_approval for a start: the new session. */
  ref?: string;
  label?: string;
}
/** What a notice says about the conversation: the receiver's person allowed or denied it, or a message didn't land. */
export type RemoteOutcome = "allowed" | "denied" | "undelivered";
/** A session on another controller, as its daemon lists it. */
export interface RemoteListing {
  ref: string;
  label: string;
  agent: string;
  status: PeerStatus;
  lastActive: number | null;
}
/** The sending session on this host, as the other controller sees it. */
export interface RemoteFrom {
  ref: string;
  label: string;
  agent: string;
  onBehalfOf: string;
}

/**
 * Another controller, reached through the local cc-controller daemon (D4). Its sessions are
 * one person's: only that person's sessions list or reach them, and what it sends in runs as
 * that person. The receiving controller guards its own boundary (it may hold a message for
 * its person's approval).
 */
export interface RemotePeerHost {
  /** Host id, e.g. "mac": refs read `[mac:3fa9c1]`. */
  id: string;
  /** e.g. "MacBook". */
  label: string;
  /** RBAC username of the person whose sessions these are. */
  person: string;
  /** Agent a start from that host runs when it names none. */
  defaultAgent?: string;
  list(): Promise<RemoteListing[]>;
  message(from: RemoteFrom, to: string, text: string, hops: number): Promise<RemoteResult>;
  start(from: RemoteFrom, agent: string | undefined, text: string, hops: number): Promise<RemoteResult>;
  notice(from: { ref: string; label: string }, to: string, text: string, outcome?: RemoteOutcome): Promise<void>;
}

/**
 * A conversation with someone outside this controller (a principal, or a session on another
 * controller) that the person allowed or denied: the app lists them and can revoke one.
 * Same shape as cc-controller's own list. Times are ms.
 */
export interface PeerConversation {
  id: string;
  peer: { host: string; hostLabel: string; ref: string; label: string };
  local: { ref: string; label: string };
  state: "allowed" | "denied";
  since: number;
  until?: number;
}

/** The local daemon's person, for calls that come in from another controller through it. */
export interface RemoteLink {
  person: string;
  userId: string;
  userPlatform: string;
}

const refused = (reason: string): RemoteResult => ({ status: "refused", reason });

/** Whose visibility a caller has: a principal sees what its person sees. */
const viewerOf = (caller: PeerCaller) => caller.principal?.viewer ?? { userId: caller.userId, userPlatform: caller.userPlatform };

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

/** Who messaged a scope from outside it and may get a reply: an api: scope, a principal or a remote session. */
interface InboundNote {
  at: number;
  agentId: string;
  principal?: PeerPrincipal;
  remote?: RemoteSender;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class PeerService implements PeerProvider {
  /** sender scope → send timestamps inside the rate window. */
  private readonly sends = new Map<string, number[]>();
  /** sender scope → fresh-start timestamps inside the start window. */
  private readonly starts = new Map<string, number[]>();
  /** receiving scope → (api: scope or principal → when it last messaged the receiver, and its agent). */
  private readonly apiInbound = new Map<string, Map<string, InboundNote>>();
  /** principal name → what's waiting for it, oldest first. */
  private readonly inboxes = new Map<string, PeerInboxItem[]>();
  /** sending scope → (`remote:<host>:<ref>`, or `remote:<host>:*` for a start → when it last wrote there): whose notices it takes. */
  private readonly outbound = new Map<string, Map<string, number>>();
  private readonly remotes: Map<string, RemotePeerHost>;
  /** `remote:<host>:<ref>` → its last-seen session label, for the conversations list. */
  private readonly remoteLabels = new Map<string, string>();

  constructor(private readonly deps: PeerDeps, remotes: RemotePeerHost[] = []) {
    this.remotes = new Map(remotes.map((host) => [host.id, host]));
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
      if (!(await this.deps.canView({ agentId, ...viewerOf(caller) }, scope))) continue;
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
      fromSudo: this.fromSudo(from),
      ...(from.principal && { principal: from.principal.name }),
    };
    const state = this.deps.deliveryState(entry.scope, meta);
    const person = this.deps.personName(from.userId, from.userPlatform) ?? from.userId;
    const fromLabel = await this.callerLabel(from);
    const tellSender = (text: string) => from.principal
      ? Promise.resolve(this.notify(from.principal.name, text))
      : from.remote
        ? (from.notice ? Promise.resolve() : this.noticeRemote(from.remote, entry, text, "undelivered"))
        : this.deps.post(from.scope, text);
    this.deps.deliver(entry.scope, wrapped, meta).then(async (result) => {
      if (result.dropped) {
        // It waited behind another turn and never ran: tell the sender's conversation.
        await tellSender(`Your message to ${entryName(entry)} wasn't delivered: ${result.dropped}.`);
        return;
      }
      // The receiver's reply belongs to its own conversation. Empty means it was coalesced
      // into a reply some other message is posting; silent means mcp__agent__no_reply.
      if (result.silent || !result.text.trim()) return;
      const preview = this.extractBody(wrapped).slice(0, PEER_PREVIEW_CHARS);
      await this.deps.post(entry.scope, `*Message from ${fromLabel} on behalf of ${person}:* ${preview}\n\n${result.text}`);
    }).catch((err) => {
      console.error(`[peers] delivery to ${entry.scope.slice(0, 40)} failed:`, err instanceof Error ? err.message : err);
      const text = `Your message to ${entryName(entry)} wasn't delivered: ${err instanceof Error ? err.message : String(err)}.`;
      if (from.principal) this.notify(from.principal.name, text);
      if (from.remote && !from.notice) void this.noticeRemote(from.remote, entry, text, "undelivered");
    });
    return state;
  }

  /** All providers' entries for the caller, newest first, capped. */
  async visible(caller: PeerCaller): Promise<PeerEntry[]> {
    const all = [...(await this.list(caller)), ...(await this.remoteEntries(caller))];
    // Other hosts' labels are as untrusted as Discord's.
    return all
      .map((e) => ({ ...e, label: sanitizePeerLabel(e.label), ...(e.host !== undefined && { host: sanitizePeerLabel(e.host) }) }))
      .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
      .slice(0, PEER_LIST_CAP);
  }

  // ── Tool entry points ──

  async listTool(caller: PeerCaller): Promise<string> {
    const self = await this.callerLabel(caller);
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

    // A reply to a principal waits in its inbox; principals don't message each other.
    if (target.principal) {
      if (caller.principal) return `Error: ${NOT_FOUND}`;
      if (!this.takeRateSlot(caller.scope)) return `Error: rate limit (${PEER_RATE_LIMIT} sends per ${PEER_RATE_WINDOW_MS / 60_000} minutes)`;
      this.deps.pairings?.touch(target.principal, caller.scope);
      this.pushInbox(target.principal, {
        at: new Date(this.deps.now()).toISOString(),
        kind: "message",
        from: `${await this.callerLabel(caller)} [${peerRef(caller.scope)}]`,
        agent: caller.agentId,
        onBehalfOf: person,
        text: message,
      });
      return `delivered: ${entryName(target)}`;
    }
    if (target.remoteHost) return this.sendRemote(caller, target, message, person);

    // Visibility is checked again at send time, not only when listing.
    if (!target.scope.startsWith("api:") && !target.host) {
      const agentId = this.deps.agentForScope(target.scope);
      if (!agentId || !(await this.deps.canView({ agentId, ...viewerOf(caller) }, target.scope))) {
        return `Error: ${NOT_FOUND}`;
      }
    }
    // Sudo sessions can message anywhere their person can see; only sudo sessions can message a
    // scope in sudo mode, since the message would run there as root (Shitiz, 2026-10-26).
    if (!target.host && this.deps.inSudo(target.scope) && !this.fromSudo(caller)) {
      return `Error: ${SUDO_TARGET}`;
    }
    // A principal's turn runs as the principal: it must be able to use the target's agent itself.
    if (caller.principal && !this.deps.canUseAgent?.(caller.userId, caller.userPlatform, target.agentId)) {
      return `Error: ${caller.principal.name} can't use agent ${target.agentId}`;
    }
    if (!this.takeRateSlot(caller.scope)) return `Error: rate limit (${PEER_RATE_LIMIT} sends per ${PEER_RATE_WINDOW_MS / 60_000} minutes)`;

    const wrapped = await this.wrap(caller, message);
    if (caller.principal) return this.sendAsPrincipal(caller, caller.principal, target, wrapped, message);
    if (caller.scope.startsWith("api:")) this.noteInbound(target.scope, caller);
    const state = await this.send(target, wrapped, caller);
    return `${state}: ${entryName(target)}${state === "queued" ? " (it's busy with someone else's turn; your message starts its own turn when that ends)" : ""}`;
  }

  /**
   * A fresh session on this host for the caller's person (D3b §8): `peer:<id>`, bound to that
   * person with origin `peer`, its first turn the wrapped message. No app approval locally; the
   * person must be able to run the agent, and each sending scope gets PEER_START_LIMIT an hour.
   * A principal's start is bound to the person it works for, with origin = its name, and is
   * paired with it from the start (it's the principal's own session).
   */
  async startTool(caller: PeerCaller, host: unknown, agent: unknown, message: unknown): Promise<string> {
    if (typeof message !== "string" || !message.trim()) return "Error: `message` is required";
    if (message.length > PEER_MAX_MESSAGE_CHARS) return `Error: message is longer than ${PEER_MAX_MESSAGE_CHARS} characters`;
    if (host !== undefined && host !== null && typeof host !== "string") return "Error: `host` must be a string";
    if (agent !== undefined && agent !== null && typeof agent !== "string") return "Error: `agent` must be a string";

    const person = this.deps.personName(caller.userId, caller.userPlatform);
    if (!person) return "Error: this session has no person behind it, so it can't start sessions";
    if (caller.hops + 1 > PEER_HOP_LIMIT) return "Error: hop limit";
    // Another host's controller decides there (D4): it may ask its person first.
    if (typeof host === "string" && host.trim() && host.trim().toLowerCase() !== this.deps.hostName.toLowerCase()) {
      return this.startRemote(caller, host.trim(), agent, message, person);
    }
    if (!this.deps.canUseAgent || !this.deps.createPeerScope) return "Error: starting sessions isn't available here";
    const agentId = typeof agent === "string" && agent.trim()
      ? agent.trim()
      : caller.principal ? caller.principal.defaultAgent : caller.agentId;
    if (!agentId) return "Error: `agent` is required";
    // Unknown and not allowed read the same, so the error doesn't list agents.
    if (!this.deps.canUseAgent(caller.userId, caller.userPlatform, agentId)) return `Error: no agent ${person} can use is called "${agentId.slice(0, 60)}"`;
    if (!this.takeSlot(this.starts, caller.scope, PEER_START_LIMIT, PEER_START_WINDOW_MS)) {
      return `Error: rate limit (${PEER_START_LIMIT} new sessions per hour)`;
    }

    const owner = caller.principal?.forPerson ?? person;
    const scope = this.deps.createPeerScope(agentId, owner, caller.principal?.name ?? "peer");
    if (caller.principal) {
      this.deps.pairings?.decide(caller.principal.name, scope, true);
      this.noteInbound(scope, caller);
    }
    const entry: PeerEntry = {
      scope,
      ref: peerRef(scope),
      label: await this.labelFor(scope),
      agentId,
      status: "idle",
      lastActive: this.deps.now(),
      sudo: false,
    };
    const state = await this.send(entry, await this.wrap(caller, message), caller);
    return `started${state === "queued" ? " (queued)" : ""}: ${entryName(entry)} · agent ${agentId} · scope ${scope}. ` +
      `It's an ordinary session of ${owner}: message it with mcp__peers__send to "${entryName(entry)}"; it replies the same way.`;
  }

  /** What's waiting for a principal (oldest first, at most `max`), removed as it's returned. */
  drainInbox(principal: string, max = 50): PeerInboxItem[] {
    const items = this.inboxes.get(principal) ?? [];
    const taken = items.splice(0, Math.max(1, max));
    if (!items.length) this.inboxes.delete(principal);
    return taken;
  }

  // ── From another controller (D4), through the local daemon ──

  /** This host's sessions the daemon's person sees, for the other controller's list. */
  async remoteSessions(link: RemoteLink): Promise<Array<RemoteListing & { sudo: boolean }>> {
    const viewer: PeerCaller = { scope: "remote:", agentId: "", userId: link.userId, userPlatform: link.userPlatform, hops: 0 };
    return (await this.list(viewer))
      .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
      .slice(0, PEER_LIST_CAP)
      .map((e) => ({ ref: e.ref, label: sanitizePeerLabel(e.label), agent: e.agentId, status: e.status, lastActive: e.lastActive, sudo: e.sudo }));
  }

  /**
   * A message from a session on another controller to one of the daemon's person's sessions.
   * This controller guards its boundary: the first message of a new conversation is held and
   * the person is asked (peer_conversation); the outcome goes back to the sender as a notice.
   */
  async remoteInbound(link: RemoteLink, body: Record<string, unknown>): Promise<RemoteResult> {
    const caller = this.remoteCaller(link, body);
    if (typeof caller === "string") return refused(caller);
    const text = this.remoteText(body.text, PEER_MAX_MESSAGE_CHARS);
    if (!text.ok) return refused(text.error);
    const target = await this.localTarget(caller, body.to);
    if (typeof target === "string") return refused(target);
    if (this.deps.inSudo(target.scope)) return refused(SUDO_TARGET);
    const pairings = this.deps.pairings;
    if (!pairings || !this.deps.askPairing) return refused("conversations from other controllers aren't available here");
    const pairing = pairings.state(caller.scope, target.scope);
    if (pairing.kind === "denied") return refused(`${link.person} denied this conversation until ${new Date(pairing.until).toISOString()}`);
    if (pairing.kind === "pending") return refused(`an earlier message to ${target.label} is waiting for ${link.person}'s approval`);
    if (!this.takeRateSlot(caller.scope)) return refused(`rate limit (${PEER_RATE_LIMIT} sends per ${PEER_RATE_WINDOW_MS / 60_000} minutes)`);

    const wrapped = await this.wrap(caller, text.value);
    if (pairing.kind === "allowed") {
      pairings.touch(caller.scope, target.scope);
      this.noteInbound(target.scope, caller);
      return { status: await this.send(target, wrapped, caller) };
    }

    const remote = caller.remote!;
    const asker = this.remoteAsker(link, remote);
    pairings.begin(caller.scope, target.scope);
    this.deps.askPairing(asker, target, text.value.slice(0, PEER_PREVIEW_CHARS), `${asker.label} wants to message ${target.label}. Allow?`).then(async (decision) => {
      if (decision === null || decision === "unanswered") {
        pairings.cancel(caller.scope, target.scope);
        const why = decision === null ? `there's nowhere to ask ${link.person} about it` : `${link.person} didn't answer in time`;
        await this.noticeRemote(remote, target, `Your message to ${target.label} wasn't delivered: ${why}.`, "undelivered");
        return;
      }
      pairings.decide(caller.scope, target.scope, decision === "allow");
      if (decision === "deny") {
        await this.noticeRemote(remote, target, `${link.person} denied the conversation with ${target.label}: refused for 24 hours.`, "denied");
        return;
      }
      if (this.deps.inSudo(target.scope)) {
        await this.noticeRemote(remote, target, `Your message to ${target.label} wasn't delivered: ${SUDO_TARGET}.`, "undelivered");
        return;
      }
      this.noteInbound(target.scope, caller);
      const state = await this.send(target, wrapped, caller);
      await this.noticeRemote(remote, target, `${link.person} allowed the conversation with ${target.label}: your message was ${state}.`, "allowed");
    }).catch(async (err) => {
      pairings.cancel(caller.scope, target.scope);
      console.error(`[peers] pairing ask for ${target.scope.slice(0, 40)} failed:`, err instanceof Error ? err.message : err);
      await this.noticeRemote(remote, target, `Your message to ${target.label} wasn't delivered: asking ${link.person} failed.`, "undelivered");
    });
    return { status: "awaiting_approval" };
  }

  /**
   * A fresh session here for the daemon's person, started from another controller (D3b §8):
   * `peer:<id>` bound to the person, origin `peer`. The person approves (peer_conversation, on
   * the new session in the app); an allow covers that sender's starts until idle for an hour.
   */
  async remoteStart(link: RemoteLink, body: Record<string, unknown>): Promise<RemoteResult> {
    const caller = this.remoteCaller(link, body);
    if (typeof caller === "string") return refused(caller);
    const text = this.remoteText(body.text, PEER_MAX_MESSAGE_CHARS);
    if (!text.ok) return refused(text.error);
    if (body.agent !== undefined && body.agent !== null && typeof body.agent !== "string") return refused("`agent` must be a string");
    const pairings = this.deps.pairings;
    if (!this.deps.canUseAgent || !this.deps.createPeerScope || !pairings || !this.deps.askPairing) {
      return refused("starting sessions isn't available here");
    }
    const remote = caller.remote!;
    const agentId = typeof body.agent === "string" && body.agent.trim() ? body.agent.trim() : this.remotes.get(remote.host)?.defaultAgent;
    if (!agentId) return refused("`agent` is required");
    if (!this.deps.canUseAgent(link.userId, link.userPlatform, agentId)) return refused(`no agent ${link.person} can use is called "${agentId.slice(0, 60)}"`);
    const pairing = pairings.state(caller.scope, START_PAIRING);
    if (pairing.kind === "denied") return refused(`${link.person} denied new sessions from it until ${new Date(pairing.until).toISOString()}`);
    if (pairing.kind === "pending") return refused(`an earlier new session is waiting for ${link.person}'s approval`);
    if (!this.takeSlot(this.starts, caller.scope, PEER_START_LIMIT, PEER_START_WINDOW_MS)) {
      return refused(`rate limit (${PEER_START_LIMIT} new sessions per hour)`);
    }

    const scope = this.deps.createPeerScope(agentId, link.person, "peer");
    const entry: PeerEntry = { scope, ref: peerRef(scope), label: await this.labelFor(scope), agentId, status: "idle", lastActive: this.deps.now(), sudo: false };
    const wrapped = await this.wrap(caller, text.value);
    const run = () => {
      pairings.decide(caller.scope, scope, true);
      this.noteInbound(scope, caller);
      return this.send(entry, wrapped, caller);
    };
    if (pairing.kind === "allowed") {
      pairings.touch(caller.scope, START_PAIRING);
      await run();
      return { status: "started", ref: entry.ref, label: entry.label };
    }

    const asker = this.remoteAsker(link, remote);
    const refuse = async (text: string, outcome: RemoteOutcome) => {
      this.deps.dropPeerScope?.(scope);
      await this.noticeRemote(remote, entry, text, outcome);
    };
    pairings.begin(caller.scope, START_PAIRING);
    this.deps.askPairing(asker, entry, text.value.slice(0, PEER_PREVIEW_CHARS),
      `${asker.label} wants to start a new session on ${this.deps.hostName} (agent ${agentId}). Allow?`).then(async (decision) => {
      if (decision === null || decision === "unanswered") {
        pairings.cancel(caller.scope, START_PAIRING);
        const why = decision === null ? `there's nowhere to ask ${link.person} about it` : `${link.person} didn't answer in time`;
        await refuse(`The new session wasn't started: ${why}.`, "undelivered");
        return;
      }
      pairings.decide(caller.scope, START_PAIRING, decision === "allow");
      if (decision === "deny") {
        await refuse(`${link.person} denied new sessions on ${this.deps.hostName}: refused for 24 hours.`, "denied");
        return;
      }
      const state = await run();
      await this.noticeRemote(remote, entry, `${link.person} allowed the new session ${entry.label}: your message was ${state}.`, "allowed");
    }).catch(async (err) => {
      pairings.cancel(caller.scope, START_PAIRING);
      console.error(`[peers] start ask from ${caller.scope.slice(0, 40)} failed:`, err instanceof Error ? err.message : err);
      await refuse(`The new session wasn't started: asking ${link.person} failed.`, "undelivered");
    });
    return { status: "awaiting_approval", ref: entry.ref, label: entry.label };
  }

  /**
   * The other controller's notice about a conversation a session here opened (allowed, denied,
   * a message that didn't land). It runs as a turn in that session, so the agent knows. Only
   * sessions that wrote to that remote session (or started one there) in the last 24 h take one.
   */
  async remoteNotice(link: RemoteLink, body: Record<string, unknown>): Promise<RemoteResult> {
    const caller = this.remoteCaller(link, { ...body, hops: 1 });
    if (typeof caller === "string") return refused(caller);
    const text = this.remoteText(body.text, PEER_NOTICE_MAX_CHARS);
    if (!text.ok) return refused(text.error);
    const target = await this.localTarget(caller, body.to);
    if (typeof target === "string") return refused(target);
    const remote = caller.remote!;
    const sent = this.outbound.get(target.scope);
    const now = this.deps.now();
    const wroteTo = (key: string) => {
      const at = sent?.get(key);
      return at !== undefined && now - at < PEER_API_REPLY_WINDOW_MS;
    };
    if (!wroteTo(caller.scope) && !wroteTo(`remote:${remote.host}:*`)) return refused(NOT_FOUND);
    if (this.deps.inSudo(target.scope)) return refused(SUDO_TARGET);
    if (!this.takeRateSlot(caller.scope)) return refused(`rate limit (${PEER_RATE_LIMIT} sends per ${PEER_RATE_WINDOW_MS / 60_000} minutes)`);
    // The other side's person allowed it: the conversation is open both ways.
    if (body.outcome === "allowed") {
      this.openReverse(caller.scope, target.scope);
      this.noteOutbound(target.scope, caller.scope);
    }
    const about = `${sanitizePeerLabel(remote.label)} [${this.callerRef(caller)}]`;
    const host = sanitizePeerLabel(remote.hostLabel);
    const wrapped = [
      `[peer: notice from ${host} about ${about} · on behalf of ${link.person} · host ${host}]`,
      `<cross-session-message from="${about.replace(/"/g, "'")}">`,
      escapePeerText(text.value),
      `</cross-session-message>`,
    ].join("\n");
    return { status: await this.send(target, wrapped, { ...caller, hops: 0, notice: true }) };
  }

  /**
   * The person's conversations with principals and other controllers' sessions: stored allows
   * and denies still in force (pre-approved pairs aren't listed: config decides those).
   */
  async conversations(person: string): Promise<PeerConversation[]> {
    const out: PeerConversation[] = [];
    for (const decision of this.deps.pairings?.decisions?.() ?? []) {
      const peer = this.conversationPeer(decision.principal, person);
      if (!peer) continue;
      const local = decision.scope === START_PAIRING
        ? { ref: "*", label: "new sessions" }
        : { ref: peerRef(decision.scope), label: await this.labelFor(decision.scope) };
      out.push({ id: conversationId(decision.principal, decision.scope), peer, local, state: decision.state, since: decision.since, until: decision.until });
    }
    return out;
  }

  /** Revoke one of the person's conversations by id: the next message asks again. False if it isn't theirs or is gone. */
  forgetConversation(person: string, id: string): boolean {
    const pairings = this.deps.pairings;
    if (!pairings?.decisions || !pairings.revoke) return false;
    const decision = pairings.decisions().find((d) => conversationId(d.principal, d.scope) === id && this.conversationPeer(d.principal, person));
    return decision ? pairings.revoke(decision.principal, decision.scope) : false;
  }

  /** Who a stored pairing is with, if it belongs to this person. */
  private conversationPeer(key: string, person: string): PeerConversation["peer"] | null {
    const remote = /^remote:([^:]+):(.+)$/.exec(key);
    if (remote) {
      const host = this.remotes.get(remote[1]);
      if (!host || host.person !== person) return null;
      return { host: host.id, hostLabel: sanitizePeerLabel(host.label), ref: remote[2], label: this.remoteLabels.get(key) ?? `${host.id}:${remote[2]}` };
    }
    const principal = this.deps.principal?.(key);
    if (!principal || principal.forPerson !== person) return null;
    return { host: "principal", hostLabel: sanitizePeerLabel(principal.host), ref: peerRef(`principal:${principal.name}`), label: sanitizePeerLabel(principal.label) };
  }

  private rememberRemoteLabel(key: string, label: string): void {
    this.remoteLabels.delete(key);
    this.remoteLabels.set(key, label);
    // Bounded: the oldest label goes first (the list falls back to host:ref).
    if (this.remoteLabels.size > 1000) this.remoteLabels.delete(this.remoteLabels.keys().next().value!);
  }

  // ── Internals ──

  /**
   * A principal's send after the common checks: an allowed pairing delivers now, a new one is
   * held until its person answers, a denied or pending one is refused.
   */
  private async sendAsPrincipal(caller: PeerCaller, principal: PeerPrincipal, target: PeerEntry, wrapped: string, message: string): Promise<string> {
    const pairings = this.deps.pairings;
    if (!pairings) return "Error: pairings aren't available here";
    const pairing = pairings.state(principal.name, target.scope);
    if (pairing.kind === "denied") {
      return `Error: ${principal.forPerson} denied messages to ${entryName(target)} until ${new Date(pairing.until).toISOString()}`;
    }
    if (pairing.kind === "pending") return `Error: an earlier message to ${entryName(target)} is waiting for ${principal.forPerson}'s approval`;
    if (pairing.kind === "allowed") {
      pairings.touch(principal.name, target.scope);
      this.noteInbound(target.scope, caller);
      const state = await this.send(target, wrapped, caller);
      return `${state}: ${entryName(target)}${state === "queued" ? " (it's busy with someone else's turn; your message starts its own turn when that ends)" : ""}`;
    }

    // A new pairing: hold the message and ask.
    if (!this.deps.askPairing) return "Error: pairings aren't available here";
    pairings.begin(principal.name, target.scope);
    const preview = message.slice(0, PEER_PREVIEW_CHARS);
    this.deps.askPairing(principal, target, preview).then(async (decision) => {
      if (decision === null || decision === "unanswered") {
        pairings.cancel(principal.name, target.scope);
        const why = decision === null ? `there's nowhere to ask ${principal.forPerson} about it` : `${principal.forPerson} didn't answer in time`;
        this.notify(principal.name, `Your message to ${entryName(target)} wasn't delivered: ${why}.`);
        return;
      }
      pairings.decide(principal.name, target.scope, decision === "allow");
      if (decision === "deny") {
        this.notify(principal.name, `${principal.forPerson} denied messages to ${entryName(target)}: refused for 24 hours.`);
        return;
      }
      // Sudo mode may have started while it waited: a principal never messages a sudo-mode scope.
      if (this.deps.inSudo(target.scope)) {
        this.notify(principal.name, `Your message to ${entryName(target)} wasn't delivered: ${SUDO_TARGET}.`);
        return;
      }
      this.noteInbound(target.scope, caller);
      const state = await this.send(target, wrapped, caller);
      this.notify(principal.name, `${principal.forPerson} allowed messages to ${entryName(target)}: your message was ${state}.`);
    }).catch((err) => {
      pairings.cancel(principal.name, target.scope);
      console.error(`[peers] pairing ask for ${target.scope.slice(0, 40)} failed:`, err instanceof Error ? err.message : err);
      this.notify(principal.name, `Your message to ${entryName(target)} wasn't delivered: asking ${principal.forPerson} failed.`);
    });
    return `held: ${entryName(target)} (a new pairing: waiting for ${principal.forPerson}'s approval; the outcome comes to your inbox)`;
  }

  /** A message to a session on another controller: its daemon passes it on, and that controller decides. */
  private async sendRemote(caller: PeerCaller, target: PeerEntry, message: string, person: string): Promise<string> {
    const host = this.remotes.get(target.remoteHost!);
    if (!host || caller.principal || caller.remote || host.person !== person) return `Error: ${NOT_FOUND}`;
    if (!this.takeRateSlot(caller.scope)) return `Error: rate limit (${PEER_RATE_LIMIT} sends per ${PEER_RATE_WINDOW_MS / 60_000} minutes)`;
    const key = target.scope;
    this.noteOutbound(caller.scope, key);
    this.rememberRemoteLabel(key, sanitizePeerLabel(target.label));
    let result: RemoteResult;
    try {
      result = await host.message(await this.remoteFrom(caller, person), target.remoteRef!, message, caller.hops + 1);
    } catch (err) {
      return `Error: ${host.label} is unreachable (${err instanceof Error ? err.message : String(err)})`;
    }
    if (result.status === "delivered" || result.status === "queued") {
      this.openReverse(key, caller.scope);
      return `${result.status}: ${entryName(target)}${result.status === "queued" ? " (it's busy; your message runs when it's free)" : ""}`;
    }
    if (result.status === "awaiting_approval") {
      return `held: ${entryName(target)} (a new conversation: waiting for approval on ${host.label}; the outcome comes to this session as a notice)`;
    }
    return `Error: ${sanitizePeerLabel(result.reason ?? "refused").slice(0, 300)}`;
  }

  /** mcp__peers__start on another controller: it starts the session, or holds the start for its person's approval. */
  private async startRemote(caller: PeerCaller, wantHost: string, agent: unknown, message: string, person: string): Promise<string> {
    const lower = wantHost.toLowerCase();
    const host = [...this.remotes.values()].find((h) => h.id.toLowerCase() === lower || h.label.toLowerCase() === lower);
    if (!host || caller.principal || caller.remote || host.person !== person) return `Error: ${REMOTE_START}`;
    if (!this.takeSlot(this.starts, caller.scope, PEER_START_LIMIT, PEER_START_WINDOW_MS)) {
      return `Error: rate limit (${PEER_START_LIMIT} new sessions per hour)`;
    }
    this.noteOutbound(caller.scope, `remote:${host.id}:*`);
    let result: RemoteResult;
    try {
      const agentName = typeof agent === "string" && agent.trim() ? agent.trim() : undefined;
      result = await host.start(await this.remoteFrom(caller, person), agentName, message, caller.hops + 1);
    } catch (err) {
      return `Error: ${host.label} is unreachable (${err instanceof Error ? err.message : String(err)})`;
    }
    if (result.status === "started" || result.status === "delivered" || result.status === "queued") {
      if (!result.ref || !REF.test(result.ref)) return `Error: ${host.label} didn't say which session it started`;
      const entry = this.remoteEntry(host, { ref: result.ref, label: result.label ?? "new session", agent: typeof agent === "string" ? agent : "", status: "idle", lastActive: this.deps.now() });
      this.noteOutbound(caller.scope, entry.scope);
      this.openReverse(entry.scope, caller.scope);
      const name = entryName({ ...entry, label: sanitizePeerLabel(entry.label) });
      return `started on ${host.label}: ${name}. Message it with mcp__peers__send to "${name}"; it replies the same way.`;
    }
    if (result.status === "awaiting_approval") {
      return `held: a new session on ${host.label} (waiting for approval there; the outcome comes to this session as a notice)`;
    }
    return `Error: ${sanitizePeerLabel(result.reason ?? "refused").slice(0, 300)}`;
  }

  /** Other controllers' sessions, for sessions of the person they belong to (never principals or remote callers). */
  private async remoteEntries(caller: PeerCaller): Promise<PeerEntry[]> {
    if (caller.principal || caller.remote || !this.remotes.size) return [];
    const person = this.deps.personName(caller.userId, caller.userPlatform);
    const hosts = [...this.remotes.values()].filter((host) => host.person === person);
    const lists = await Promise.all(hosts.map(async (host) => {
      try {
        return (await host.list()).filter((s) => typeof s?.ref === "string" && REF.test(s.ref)).map((s) => this.remoteEntry(host, s));
      } catch (err) {
        console.warn(`[peers] listing ${host.id} failed:`, err instanceof Error ? err.message : err);
        return [];
      }
    }));
    return lists.flat();
  }

  private remoteEntry(host: RemotePeerHost, s: RemoteListing): PeerEntry {
    const status: PeerStatus = s.status === "busy" || s.status === "closed" ? s.status : "idle";
    return {
      scope: `remote:${host.id}:${s.ref}`,
      ref: `${host.id}:${s.ref}`,
      label: typeof s.label === "string" ? s.label.slice(0, 200) : "unnamed session",
      agentId: sanitizePeerLabel(typeof s.agent === "string" && s.agent ? s.agent : "claude-code").slice(0, 60),
      status,
      lastActive: typeof s.lastActive === "number" ? s.lastActive : null,
      sudo: false,
      host: host.label,
      remoteHost: host.id,
      remoteRef: s.ref,
    };
  }

  /** How the other controller sees the sending session. */
  private async remoteFrom(caller: PeerCaller, person: string): Promise<RemoteFrom> {
    return { ref: peerRef(caller.scope), label: await this.callerLabel(caller), agent: caller.agentId, onBehalfOf: person };
  }

  /**
   * The caller for a request from another controller: one of the link person's configured hosts,
   * a 6-hex ref, hops within the limit. Its turns run as the daemon's person.
   */
  private remoteCaller(link: RemoteLink, body: Record<string, unknown>): PeerCaller | string {
    const from = body.from && typeof body.from === "object" && !Array.isArray(body.from) ? body.from as Record<string, unknown> : null;
    if (!from) return "`from` is required";
    const host = typeof from.host === "string" ? this.remotes.get(from.host) : undefined;
    if (!host || host.person !== link.person) return "unknown host";
    if (typeof from.ref !== "string" || !REF.test(from.ref)) return "`from.ref` must be 6 hex characters";
    const hops = body.hops;
    if (typeof hops !== "number" || !Number.isInteger(hops) || hops < 1) return "`hops` must be a positive integer";
    if (hops > PEER_HOP_LIMIT) return "hop limit";
    const label = sanitizePeerLabel(typeof from.label === "string" ? from.label.slice(0, 200) : "");
    const agent = sanitizePeerLabel(typeof from.agent === "string" && from.agent.trim() ? from.agent.slice(0, 60) : "claude-code");
    if (label) this.rememberRemoteLabel(`remote:${host.id}:${from.ref}`, label);
    return {
      scope: `remote:${host.id}:${from.ref}`,
      agentId: agent,
      userId: link.userId,
      userPlatform: link.userPlatform,
      hops: hops - 1,
      remote: { host: host.id, hostLabel: host.label, ref: from.ref, label, agent },
    };
  }

  private remoteText(value: unknown, max: number): { ok: true; value: string } | { ok: false; error: string } {
    if (typeof value !== "string" || !value.trim()) return { ok: false, error: "`text` is required" };
    if (value.length > max) return { ok: false, error: `message is longer than ${max} characters` };
    return { ok: true, value };
  }

  /** One of the daemon's person's sessions here, by ref (`abc123` or `[abc123]`). */
  private async localTarget(caller: PeerCaller, to: unknown): Promise<PeerEntry | string> {
    if (typeof to !== "string" || !to.trim()) return "`to` is required";
    const ref = to.trim().replace(/^\[|\]$/g, "").toLowerCase();
    if (!REF.test(ref)) return NOT_FOUND;
    return (await this.list(caller)).find((e) => e.ref === ref) ?? NOT_FOUND;
  }

  /** The remote session as the approval names it: "MacBook session 'App Debugging'". */
  private remoteAsker(link: RemoteLink, remote: RemoteSender): PeerPrincipal {
    return {
      name: `remote:${remote.host}:${remote.ref}`,
      label: `${sanitizePeerLabel(remote.hostLabel)} session '${sanitizePeerLabel(remote.label)}'`,
      host: remote.hostLabel,
      forPerson: link.person,
      viewer: { userId: link.userId, userPlatform: link.userPlatform },
    };
  }

  /** The other side allowed the conversation (or never needed to ask): its replies here are part of it. A deny here stands. */
  private openReverse(remoteKey: string, scope: string): void {
    const pairings = this.deps.pairings;
    if (!pairings) return;
    const state = pairings.state(remoteKey, scope).kind;
    if (state === "allowed") pairings.touch(remoteKey, scope);
    else if (state === "new") pairings.decide(remoteKey, scope, true);
  }

  private noteOutbound(scope: string, remoteKey: string): void {
    const sent = this.outbound.get(scope) ?? new Map<string, number>();
    sent.set(remoteKey, this.deps.now());
    this.outbound.set(scope, sent);
  }

  /** Tell a session on another controller how its message or start went. Best effort. */
  private async noticeRemote(sender: RemoteSender, about: { ref: string; label: string }, text: string, outcome?: RemoteOutcome): Promise<void> {
    const host = this.remotes.get(sender.host);
    if (!host) return;
    await host.notice({ ref: about.ref, label: sanitizePeerLabel(about.label) }, sender.ref, text, outcome).catch((err) =>
      console.warn(`[peers] notice to ${sender.host}:${sender.ref} failed:`, err instanceof Error ? err.message : err));
  }

  /** The wrapped, orchestrator-stamped message the target sees. */
  async wrap(caller: PeerCaller, message: string): Promise<string> {
    const from = `${await this.callerLabel(caller)} [${this.callerRef(caller)}]`;
    const person = this.deps.personName(caller.userId, caller.userPlatform) ?? caller.userId;
    const noReply = caller.scope.startsWith("#sched:") ? " · no reply possible" : "";
    const host = caller.principal
      ? sanitizePeerLabel(caller.principal.host)
      : caller.remote ? sanitizePeerLabel(caller.remote.hostLabel) : this.deps.hostName;
    return [
      `[peer: from ${from} · agent ${caller.agentId} · on behalf of ${person} · host ${host}${noReply}]`,
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

  private callerLabel(caller: PeerCaller): Promise<string> {
    if (caller.principal) return Promise.resolve(sanitizePeerLabel(caller.principal.label));
    if (caller.remote) return Promise.resolve(sanitizePeerLabel(caller.remote.label));
    return this.labelFor(caller.scope);
  }

  /** The ref replies use: this host's, or `<host>:<ref>` for a session on another controller. */
  private callerRef(caller: PeerCaller): string {
    return caller.remote ? `${caller.remote.host}:${caller.remote.ref}` : peerRef(caller.scope);
  }

  /** Principals and other controllers' sessions are never in sudo mode; a session is when its open session runs as root. */
  private fromSudo(caller: PeerCaller): boolean {
    return !caller.principal && !caller.remote && this.deps.runsAsRoot(caller.scope);
  }

  /** The receiver may reply to this api: scope, principal or remote session for the next 24 h. */
  private noteInbound(targetScope: string, caller: PeerCaller): void {
    const inbound = this.apiInbound.get(targetScope) ?? new Map<string, InboundNote>();
    inbound.set(caller.scope, {
      at: this.deps.now(),
      agentId: caller.agentId,
      ...(caller.principal && { principal: caller.principal }),
      ...(caller.remote && { remote: caller.remote }),
    });
    this.apiInbound.set(targetScope, inbound);
  }

  private notify(principal: string, text: string): void {
    this.pushInbox(principal, { at: new Date(this.deps.now()).toISOString(), kind: "notice", text });
  }

  private pushInbox(principal: string, item: PeerInboxItem): void {
    const items = this.inboxes.get(principal) ?? [];
    items.push(item);
    if (items.length > PEER_INBOX_CAP) items.splice(0, items.length - PEER_INBOX_CAP);
    this.inboxes.set(principal, items);
  }

  /** `to` may be a ref, a unique label, or the full `label [ref]` form. */
  private async resolve(caller: PeerCaller, to: string): Promise<PeerEntry | string> {
    // Another controller's sessions carry their host: `[mac:3fa9c1]`.
    const full = to.match(/^(.*)\s\[((?:[a-z0-9-]{1,32}:)?[0-9a-f]{6})\]$/i);
    const refOnly = /^\[?((?:[a-z0-9-]{1,32}:)?[0-9a-f]{6})\]?$/i.exec(to);
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
    if (wantLabel === (await this.callerLabel(caller))) return "can't send to this session itself";
    return NOT_FOUND;
  }

  /** api: scopes and principals that messaged the caller's session in the last 24 h: reachable by reply only. */
  private async replyableApiScopes(caller: PeerCaller): Promise<PeerEntry[]> {
    const inbound = this.apiInbound.get(caller.scope);
    if (!inbound) return [];
    const now = this.deps.now();
    const out: PeerEntry[] = [];
    for (const [scope, { at, agentId, principal, remote }] of inbound) {
      if (now - at > PEER_API_REPLY_WINDOW_MS) { inbound.delete(scope); continue; }
      if (remote) {
        const host = this.remotes.get(remote.host);
        if (host) out.push(this.remoteEntry(host, { ref: remote.ref, label: remote.label, agent: agentId, status: "idle", lastActive: at }));
        continue;
      }
      if (principal) {
        out.push({ scope, ref: peerRef(scope), label: sanitizePeerLabel(principal.label), agentId, status: "idle", lastActive: at, sudo: false, principal: principal.name });
        continue;
      }
      out.push({ scope, ref: peerRef(scope), label: await this.labelFor(scope), agentId, status: this.deps.status(scope), lastActive: at, sudo: false });
    }
    return out;
  }

  private takeRateSlot(senderScope: string): boolean {
    return this.takeSlot(this.sends, senderScope, PEER_RATE_LIMIT, PEER_RATE_WINDOW_MS);
  }

  private takeSlot(log: Map<string, number[]>, senderScope: string, limit: number, windowMs: number): boolean {
    const now = this.deps.now();
    const recent = (log.get(senderScope) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      log.set(senderScope, recent);
      return false;
    }
    recent.push(now);
    log.set(senderScope, recent);
    return true;
  }
}
