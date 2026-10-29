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
 *
 * Read (§5): raw records when every participant is P, otherwise the text-only projection.
 * Written (§4, §7): messages into writable (app:/peer:) scopes only, and new app: scopes.
 * Approvals (§6): those in listed scopes reach the app; only app:/peer: ones are decided there.
 * AskUserQuestion questions are approvals with `questions`, answered with `answers`.
 * Sudo (§9): P toggles sudo mode on writable scopes, with Discord's canSudo check.
 */

import { createHash } from "node:crypto";
import type { Participant } from "./participants.js";
import type { ScopeBinding } from "./scope-bindings.js";
import { projectTranscript, transcriptRecordId, withRecordIds, type TranscriptRecord } from "./controller-transcript.js";
import { answersError, type ApprovalBehaviour, type ApprovalHubEvent, type ControllerApproval, type ControllerApprovals } from "./controller-approvals.js";
import type { GatekeeperReview } from "./gatekeeper.js";
import type { AskQuestion, ChannelAttachment } from "./types.js";
import { CONTROLLER_MESSAGE_MAX_FILES, type ControllerFile, type ControllerFileStore } from "./controller-files.js";

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
  /** ISO time of the last message P (this controller's person) sent here (Discord, terminal or the app); null if none known. */
  lastUserMessageAt: string | null;
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

/** Capabilities the Stockade source advertises; grows as D3b units land (d3b-5/6/7). */
export const CONTROLLER_CAPABILITIES = ["list", "transcript", "send", "new_session", "decide", "questions"] as const;
/** Advertised too when Stockade has sudo mode (an agent with a sudo_user). */
export const CONTROLLER_SUDO_CAPABILITY = "sudo";
/** Advertised when the service has a file store: uploads (POST sessions/:id/files) and messages with files. */
export const CONTROLLER_FILES_CAPABILITY = "files";

export type ControllerEvent =
  /** A visible session's state changed (turn started or ended, session opened or closed). */
  | { type: "session"; session: ControllerSession }
  /** A new record in a visible session's current transcript (raw or projected, as GET transcript serves it). */
  | { type: "transcript"; id: string; claudeSessionId: string; recordId: string; record: TranscriptRecord }
  /** A tool call in a visible session waits for approval. answerIn set = answered there, not in the app. */
  | {
    type: "approval";
    id: string;
    sessionId: string;
    scope: string;
    tool: string;
    input: Record<string, unknown>;
    receivedAt: string;
    agentId: string | null;
    review: GatekeeperReview | null;
    answerIn: "discord" | "terminal" | null;
    /** AskUserQuestion only: the questions (absent for tool approvals). */
    questions?: AskQuestion[];
  }
  /** That approval was answered (anywhere) or timed out. */
  | { type: "decision"; id: string; sessionId: string; scope: string; behaviour: ApprovalBehaviour };

/** A refusal the routes turn into an HTTP status and `{error: code}`. */
export class ControllerError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 413, readonly code: string, message: string = code) {
    super(message);
  }
}

export const TRANSCRIPT_DEFAULT_LIMIT = 500;
export const TRANSCRIPT_MAX_LIMIT = 1000;
/** How often a busy session's transcript is checked for new records while an app is connected. */
export const TRANSCRIPT_FOLLOW_MS = 1000;
export const CONTROLLER_MESSAGE_MAX_CHARS = 100_000;
/**
 * How long GET sessions waits on visibility checks and labels (Discord lookups, slow while its
 * caches are cold after a restart). Rows still resolving then are sent later as `session` events.
 */
export const SESSIONS_LIST_BUDGET_MS = 300;

const TIMED_OUT = Symbol("timed out");

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
  /** The label shown while describe is still resolving (default: the scope), e.g. `<#channel>`. */
  fallbackLabel?: (scope: string) => string;
  /** GET sessions' wait for slow lookups (default SESSIONS_LIST_BUDGET_MS). */
  listBudgetMs?: number;
  status: (scope: string) => ControllerSessionStatus;
  /** When the scope's last turn ended (epoch ms), if known since startup. */
  lastTurnEnded: (scope: string) => number | null;
  inSudo: (scope: string) => boolean;
  claudeSessionId: (scope: string) => string | null;
  /** Agents P may talk to, from config. */
  agents: () => ControllerAgent[];
  now: () => number;
  /** Raw records of the scope's current Claude session, oldest first; [] before its first session. */
  transcript: (scope: string) => Promise<TranscriptRecord[]>;
  /** Scopes with a turn running right now. */
  busyScopes: () => string[];
  /**
   * Start (or join) a turn in the scope as P, without waiting for it. Queued = held behind someone
   * else's turn. Attachments go to the agent like Discord ones (saved, listed in the prompt).
   */
  send: (scope: string, text: string, attachments?: ChannelAttachment[]) => "delivered" | "queued";
  /** Bind a new `app:<P>:<id>` scope to the agent and return it. */
  createAppScope: (agentId: string) => string;
  /** Transcript polling interval for live sessions (default TRANSCRIPT_FOLLOW_MS). */
  followMs?: number;
  /** The process's approvals hub; without it the service has no approvals. */
  approvals?: ControllerApprovals;
  /** Does P hold `approve`? Without it P sees approvals but can't decide them. */
  canApprove?: () => boolean;
  /** The person a principal (by RBAC name) works for, or null for anyone else. Its rows count as theirs for the raw view. */
  principalFor?: (name: string) => string | null;
  /** Sudo mode, when Stockade has it: P's `sudo` permission, and the /sudo toggle (true = now on). */
  sudo?: { canSudo: () => boolean; toggle: (scope: string) => Promise<boolean> };
  /** Staged uploads (capability `files`); without it uploads are 404 unsupported. */
  files?: ControllerFileStore;
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
  /** scope → how many records of its current session subscribers have been sent. */
  private followed = new Map<string, { claudeSessionId: string; count: number; raw: boolean }>();
  /** scope → the running transcript check, so two checks never send a record twice. */
  private following = new Map<string, Promise<void>>();
  private followTimer: ReturnType<typeof setInterval> | null = null;
  /** Approval events in hub order, so a decision never overtakes its approval. */
  private approvalQueue: Promise<void> = Promise.resolve();
  /** Scopes a list left unresolved at its deadline, still resolving in the background. */
  private resolvingLater = new Set<string>();

  constructor(private readonly deps: ControllerDeps) {
    deps.approvals?.subscribe((event) => {
      // Only streams open when it happened: a later one gets the waiting approvals replayed.
      const listeners = [...this.listeners];
      if (listeners.length === 0) return;
      this.approvalQueue = this.approvalQueue
        .then(() => this.forwardApproval(event, listeners))
        .catch((err) => console.error("[controller] approval event failed:", err));
    });
  }

  get person(): string {
    return this.deps.person;
  }

  /**
   * Every session listed for P, latest activity first, within the list budget: it never waits on
   * Discord longer than that. A row whose label is still resolving then is sent with the fallback
   * label; a scope whose visibility is still being checked is left out (listing it unchecked could
   * show a channel P can no longer view). Either is sent as a `session` event once resolved, the
   * row only if its label changed.
   */
  async sessions(): Promise<ControllerSession[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), this.deps.listBudgetMs ?? SESSIONS_LIST_BUDGET_MS);
    });
    try {
      const rows = await Promise.all(this.candidateScopes().map((scope) => this.listRow(scope, deadline)));
      return rows
        .filter((row): row is ControllerSession => row !== null)
        .sort((a, b) => b.lastActive - a.lastActive);
    } finally {
      clearTimeout(timer);
    }
  }

  /** One listed session by its id, or null if P can't see it. Waits for its lookups: no budget. */
  async find(id: string): Promise<ControllerSession | null> {
    const scope = this.candidateScopes().find((candidate) => controllerSessionId(candidate) === id);
    return scope ? this.row(scope) : null;
  }

  /**
   * Resolve every row in full, with no budget, so the lookups behind them (Discord's channel and
   * member caches) are warm before the app's first list. Returns how many rows are listed.
   */
  async warm(): Promise<number> {
    const rows = await Promise.all(this.candidateScopes().map((scope) => this.row(scope)));
    return rows.filter((row) => row !== null).length;
  }

  agents(): ControllerAgent[] {
    return this.deps.agents();
  }

  capabilities(): string[] {
    return [
      ...CONTROLLER_CAPABILITIES,
      ...(this.deps.sudo ? [CONTROLLER_SUDO_CAPABILITY] : []),
      ...(this.deps.files ? [CONTROLLER_FILES_CAPABILITY] : []),
    ];
  }

  subscribe(listener: (event: ControllerEvent) => void): () => void {
    this.listeners.add(listener);
    if (!this.followTimer) {
      this.followTimer = setInterval(() => {
        for (const scope of this.deps.busyScopes()) void this.follow(scope);
      }, this.deps.followMs ?? TRANSCRIPT_FOLLOW_MS);
      this.followTimer.unref?.();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.followTimer) {
        clearInterval(this.followTimer);
        this.followTimer = null;
        // Reconnecting clients page GET transcript from where they were, so start counting afresh.
        this.followed.clear();
      }
    };
  }

  /** Something about a scope changed: tell subscribers, if P can see it. New records go first, then the row. */
  async notify(scope: string): Promise<void> {
    if (this.listeners.size === 0) return;
    await this.follow(scope);
    const session = await this.row(scope);
    if (!session) return;
    for (const listener of this.listeners) listener({ type: "session", session });
  }

  /**
   * GET transcript: the session's current transcript as P may read it, oldest first, after the
   * record with id `after` (from the start when it isn't there, e.g. after a rotation).
   */
  async transcript(id: string, options: { after?: string | null; limit?: number | null } = {}): Promise<TranscriptRecord[]> {
    const session = await this.find(id);
    if (!session) throw new ControllerError(404, "not_found");
    const records = this.readable(session.scope, await this.deps.transcript(session.scope));
    const start = options.after ? records.findIndex((record, index) => transcriptRecordId(record, index) === options.after) + 1 : 0;
    const asked = Number.isFinite(options.limit) ? Math.trunc(options.limit!) : TRANSCRIPT_DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(TRANSCRIPT_MAX_LIMIT, asked));
    return records.slice(start, start + limit);
  }

  /**
   * POST message: P writes in a writable scope (§4). Read-only scopes get 403 read_only.
   * `files` are ids from upload(), taken (single use) and sent with the text; with files the
   * text may be empty.
   */
  async send(id: string, text: unknown, files?: unknown): Promise<{ delivered: true; queued: boolean }> {
    const session = await this.find(id);
    if (!session) throw new ControllerError(404, "not_found");
    if (!session.writable) throw new ControllerError(403, "read_only", "This session is read-only here.");
    const fileIds = checkedFileIds(files);
    if (fileIds.length > 0 && !this.deps.files) throw new ControllerError(404, "unsupported", "Files aren't supported here");
    const noText = text === undefined || text === null || (typeof text === "string" && !text.trim());
    const message = fileIds.length > 0 && noText ? "" : checkedText(text);
    const attachments = fileIds.length > 0 ? this.deps.files!.take(this.person, session.scope, fileIds) : undefined;
    const state = this.deps.send(session.scope, message, attachments);
    return { delivered: true, queued: state === "queued" };
  }

  /**
   * POST sessions/:id/files: stage a file P will send in a writable scope. 404 not_found /
   * unsupported, 403 read_only, 400 empty_file, 413 too_large / quota.
   */
  async upload(id: string, upload: { name: string | null; mime: string | null; data: Buffer }): Promise<{ file: ControllerFile }> {
    const store = this.deps.files;
    if (!store) throw new ControllerError(404, "unsupported", "Files aren't supported here");
    const session = await this.find(id);
    if (!session) throw new ControllerError(404, "not_found");
    if (!session.writable) throw new ControllerError(403, "read_only", "This session is read-only here.");
    return { file: store.stage(this.person, session.scope, upload) };
  }

  /**
   * POST sessions/:id/sudo (§9): /sudo from the app. Turns the writable scope's sudo mode on, or off
   * when it's on, like Discord's /sudo; a task is sent as P's first message once it's on.
   */
  async toggleSudo(id: string, body: { task?: unknown }): Promise<ControllerSession> {
    const session = await this.find(id);
    if (!session) throw new ControllerError(404, "not_found");
    if (!session.writable) throw new ControllerError(403, "read_only", "This session is read-only here.");
    const sudo = this.deps.sudo;
    if (!sudo) throw new ControllerError(404, "unsupported", "Sudo mode isn't set up here");
    if (!sudo.canSudo()) throw new ControllerError(403, "not_sudoer", "You don't have sudo.");
    const hasTask = body.task !== undefined && body.task !== null && !(typeof body.task === "string" && !body.task.trim());
    const task = hasTask ? checkedText(body.task) : null;
    const on = await sudo.toggle(session.scope);
    if (on && task) this.deps.send(session.scope, task);
    const updated = await this.row(session.scope);
    if (!updated) throw new ControllerError(404, "not_found");
    return updated;
  }

  /** POST sessions (§7): a new app:<P>:<id> scope with the agent, started with P's first message. */
  async createSession(body: { agentId?: unknown; text?: unknown }): Promise<ControllerSession> {
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    if (!agentId) throw new ControllerError(400, "agent_required", "agentId is required");
    const message = checkedText(body.text);
    if (!this.deps.agents().some((agent) => agent.id === agentId)) {
      throw new ControllerError(403, "agent_forbidden", "You can't start sessions with this agent");
    }
    const scope = this.deps.createAppScope(agentId);
    this.deps.send(scope, message);
    const session = await this.row(scope);
    if (!session) throw new Error(`new app scope is not listed: ${scope.slice(0, 60)}`);
    return session;
  }

  /** Approvals waiting in P's listed scopes, as events: sent to each new event stream. */
  async pendingApprovals(): Promise<ControllerEvent[]> {
    const visible: ControllerApproval[] = [];
    for (const approval of this.deps.approvals?.list() ?? []) {
      if (await this.listed(approval.scope)) visible.push(approval);
    }
    // Drop any answered while listed() ran, so a replay never follows its decision.
    return visible.filter((approval) => this.deps.approvals?.get(approval.id)).map(approvalEvent);
  }

  /**
   * POST approvals/:id: P allows or denies an app:/peer: approval, or answers (allow + answers)
   * or declines (deny) its questions. Answering questions doesn't need `approve`: it's P's
   * own conversation, as the asker answers in Discord.
   */
  async decide(id: string, body: { behaviour?: unknown; behavior?: unknown; answers?: unknown }): Promise<{ decided: true }> {
    const approval = this.deps.approvals?.get(id);
    if (!approval || !(await this.listed(approval.scope))) {
      throw new ControllerError(404, "not_found", "This approval was already answered");
    }
    // App-decided approvals live in app:/peer: scopes: only the person the scope is bound to decides them.
    if (!approval.answerIn && this.deps.binding(approval.scope)?.person !== this.deps.person) {
      throw new ControllerError(404, "not_found", "This approval was already answered");
    }
    if (approval.answerIn) {
      throw new ControllerError(403, "read_only", `This approval is answered in ${approval.answerIn === "discord" ? "Discord" : "the terminal"}.`);
    }
    const behaviour = body.behaviour ?? body.behavior;
    if (behaviour !== "allow" && behaviour !== "deny") {
      throw new ControllerError(400, "invalid_behaviour", "behaviour must be allow or deny");
    }
    let answers: Record<string, string> | undefined;
    if (approval.questions) {
      if (behaviour === "allow") {
        const problem = answersError(approval.questions, body.answers);
        if (problem) throw new ControllerError(400, "invalid_answers", problem);
        answers = body.answers as Record<string, string>;
      }
    } else if (!this.deps.canApprove?.()) {
      throw new ControllerError(403, "not_approver", "You can't approve actions here.");
    }
    const result = this.deps.approvals!.decide(id, behaviour, answers);
    if (result === "not_found") throw new ControllerError(404, "not_found", "This approval was already answered");
    if (result === "read_only") throw new ControllerError(403, "read_only");
    if (result === "invalid_answers") throw new ControllerError(400, "invalid_answers");
    return { decided: true };
  }

  private async forwardApproval(event: ApprovalHubEvent, listeners: Array<(event: ControllerEvent) => void>): Promise<void> {
    if (!(await this.listed(event.approval.scope))) return;
    const out: ControllerEvent = event.type === "approval"
      ? approvalEvent(event.approval)
      : {
        type: "decision",
        id: event.approval.id,
        sessionId: controllerSessionId(event.approval.scope),
        scope: event.approval.scope,
        behaviour: event.behaviour,
      };
    for (const listener of listeners) listener(out);
  }

  /**
   * Raw records when every participant is P (§5), otherwise the text-only projection. P's own
   * app: scope counts as P's before anyone has written in it.
   */
  private readable(scope: string, records: TranscriptRecord[]): TranscriptRecord[] {
    return this.rawFor(scope) ? withRecordIds(records) : projectTranscript(records);
  }

  /** Does P get the raw form? A principal working for P (Kepler) counts as P; anyone else doesn't. */
  private rawFor(scope: string): boolean {
    const person = this.deps.person;
    const participants = this.deps.participants(scope);
    return participants.every((row) => row.person === person || this.deps.principalFor?.(row.person) === person) &&
      (participants.length > 0 || this.deps.binding(scope)?.origin === "app");
  }

  /** Send subscribers the records added to a visible scope's transcript since the last check. */
  private follow(scope: string): Promise<void> {
    const previous = this.following.get(scope) ?? Promise.resolve();
    const next = previous.then(() => this.followNow(scope)).catch((err) =>
      console.error(`[controller] transcript follow failed for ${scope.slice(0, 60)}:`, err));
    this.following.set(scope, next);
    void next.finally(() => {
      if (this.following.get(scope) === next) this.following.delete(scope);
    });
    return next;
  }

  private async followNow(scope: string): Promise<void> {
    if (this.listeners.size === 0) return;
    if (!(await this.listed(scope))) return;
    const claudeSessionId = this.deps.claudeSessionId(scope);
    if (!claudeSessionId) {
      // No Claude session yet (a new app session's first turn is starting): its first
      // session's records all count as new.
      this.followed.set(scope, { claudeSessionId: "", count: 0, raw: this.rawFor(scope) });
      return;
    }
    const raw = this.rawFor(scope);
    const records = this.readable(scope, await this.deps.transcript(scope));
    const seen = this.followed.get(scope);
    // First sight of a scope: what's already there was served by GET transcript. A rotated
    // scope's new session is sent from its first record. A form change (a second person joined)
    // counts as first sight too: the two forms' counts don't line up, so the app re-reads the
    // transcript when the row's participants change.
    const from = !seen || seen.raw !== raw ? records.length : seen.claudeSessionId === claudeSessionId ? seen.count : 0;
    this.followed.set(scope, { claudeSessionId, count: records.length, raw });
    for (let index = from; index < records.length; index++) {
      const event: ControllerEvent = {
        type: "transcript",
        id: controllerSessionId(scope),
        claudeSessionId,
        recordId: transcriptRecordId(records[index], index),
        record: records[index],
      };
      for (const listener of this.listeners) listener(event);
    }
  }

  /** Is the scope listed for P? row() without building the row. */
  private async listed(scope: string): Promise<boolean> {
    const membership = await this.membership(scope);
    return !!membership && (membership === "own" || this.deps.peerSessions);
  }

  /** Scopes that may be listed for P: those P took part in, and those bound to P. */
  private candidateScopes(): string[] {
    const scopes = new Set<string>();
    for (const row of this.deps.participation(this.deps.person)) scopes.add(row.scope);
    for (const binding of this.deps.boundScopes(this.deps.person)) scopes.add(binding.scope);
    return [...scopes];
  }

  /** The session as P sees it, or null when it isn't listed for P. */
  private async row(scope: string): Promise<ControllerSession | null> {
    if (!(await this.listed(scope))) return null;
    return this.build(scope, await this.deps.describe(scope));
  }

  /** row() for the list: whatever isn't resolved by the deadline is finished in the background. */
  private async listRow(scope: string, deadline: Promise<typeof TIMED_OUT>): Promise<ControllerSession | null> {
    const listed = this.listed(scope);
    const visible = await Promise.race([listed, deadline]);
    if (visible === TIMED_OUT) {
      this.resolveLater(scope, listed.then((yes) => (yes ? this.deps.describe(scope) : null)), null);
      return null;
    }
    if (!visible) return null;
    const described = this.deps.describe(scope);
    const label = await Promise.race([described, deadline]);
    if (label !== TIMED_OUT) return this.build(scope, label);
    const fallback = this.deps.fallbackLabel?.(scope) ?? scope;
    this.resolveLater(scope, described, fallback);
    return this.build(scope, fallback);
  }

  /**
   * Finish a lookup a list gave up on. The label is null when the scope turned out not to be
   * listed; `sent` is the label the list showed, or null when it left the row out. Subscribers
   * get the row when it's new to them or its label changed.
   */
  private resolveLater(scope: string, label: Promise<string | null>, sent: string | null): void {
    if (this.resolvingLater.has(scope)) {
      void label.catch(() => {}); // the first list's lookup sends the event
      return;
    }
    this.resolvingLater.add(scope);
    void label
      .then(async (resolved) => {
        if (resolved === null || resolved === sent || this.listeners.size === 0) return;
        const session = await this.row(scope); // fast now: the lookups above warmed the caches
        if (!session) return;
        for (const listener of this.listeners) listener({ type: "session", session });
      })
      .catch((err) => console.error(`[controller] background lookup failed for ${scope.slice(0, 60)}:`, err))
      .finally(() => this.resolvingLater.delete(scope));
  }

  /** The row with this label. Synchronous, so it reads the latest state. */
  private build(scope: string, label: string): ControllerSession {
    // No awaits in here: the state is read right before the row is returned, so when two
    // notifies for one scope race, the event emitted last carries the latest state.
    const binding = this.deps.binding(scope);
    const participants = this.deps.participants(scope);
    const status = this.deps.status(scope);
    const id = controllerSessionId(scope);
    const origin = originOf(scope);
    // Writable: an app: or peer: scope bound to P (membership already requires that; this keeps it explicit).
    const writable = (origin === "app" || (origin === "peer" && !scope.startsWith("api:"))) && binding?.person === this.deps.person;
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
      lastUserMessageAt: lastPersonMessageAt(participants, this.deps.person),
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

function approvalEvent(approval: ControllerApproval): ControllerEvent {
  return {
    type: "approval",
    id: approval.id,
    sessionId: controllerSessionId(approval.scope),
    scope: approval.scope,
    tool: approval.tool,
    input: approval.input,
    receivedAt: approval.receivedAt,
    agentId: approval.agentId,
    review: approval.review,
    answerIn: approval.answerIn,
    ...(approval.questions ? { questions: approval.questions } : {}),
  };
}

/** A message's `files`: absent, or an array of up to CONTROLLER_MESSAGE_MAX_FILES id strings. */
function checkedFileIds(files: unknown): string[] {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files) || files.some((id) => typeof id !== "string" || !id)) {
    throw new ControllerError(400, "invalid_files", "files must be an array of file ids");
  }
  if (files.length > CONTROLLER_MESSAGE_MAX_FILES) throw new ControllerError(400, "too_many_files", "A message can carry at most 10 files.");
  return files as string[];
}

function checkedText(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) throw new ControllerError(400, "text_required", "text is required");
  if (text.length > CONTROLLER_MESSAGE_MAX_CHARS) throw new ControllerError(400, "text_too_long", "text is too long");
  return text;
}

/** Participation platforms where an agent acted for the person (a peer message, Kepler or a /dispatch). */
const AGENT_PARTICIPATION_PLATFORMS = new Set(["peer", "api"]);

/**
 * The latest lastTs among rows this person wrote themselves, as ISO; null if there are none.
 * Other people's rows don't count (Urvashi writing in a thread doesn't move Shitiz's time), and
 * neither do rows an agent wrote for the person. The Mac side counts only the owner's own prompts
 * the same way, so both hosts sort alike in one Recents list.
 */
function lastPersonMessageAt(participants: Participant[], person: string): string | null {
  let latestMs: number | null = null;
  for (const row of participants) {
    if (row.person !== person) continue;
    if (AGENT_PARTICIPATION_PLATFORMS.has(row.platform)) continue;
    const rowMs = Date.parse(row.lastTs);
    if (Number.isNaN(rowMs)) continue;
    if (latestMs === null || rowMs > latestMs) latestMs = rowMs;
  }
  return latestMs === null ? null : new Date(latestMs).toISOString();
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
