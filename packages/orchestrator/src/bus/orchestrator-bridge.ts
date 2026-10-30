/**
 * OrchestratorBridge — connects channel adapters to the Redis event bus.
 *
 * Channel adapters (terminal, discord) call sendAndWait() and get back
 * a Promise<string> — same contract as the old dispatchQueue.enqueue().
 *
 * Internally:
 *   1. Ensure session exists (or create it)
 *   2. Publish BusUserMessage to Redis with a correlationId
 *   3. Resolve the promise when the matching evt:result arrives
 *
 * The bridge also handles stale_session recovery by re-publishing the
 * original message after resetting the session.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChannelAttachment, ChannelResponse } from "../types.js";
import { appendLog } from "../log.js";
import type { EventBus } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { SessionMeta } from "./session-manager.js";
import type { BusWorkerEvent, BusUserMessage } from "./types.js";
import { saveAttachmentsToDisk, buildPromptWithAttachments } from "../dispatcher.js";

const LOG_DIR = join(homedir(), ".stockade", "logs");
const LOG_FILE = join(LOG_DIR, "dispatch.log");

function log(msg: string): void {
  console.log(msg);
  appendLog(LOG_FILE, msg);
}

/** How many times a timed-out dispatch may be auto-continued before giving up. */
const MAX_AUTO_CONTINUE = 5;

// Subagent dispatches emit a turn every few seconds while healthy. If one goes
// silent this long it is almost certainly wedged (e.g. an MCP tool call that
// hung with no abort path — a browse subagent stuck on a stalled apply page).
// Fail the parent's dispatch fast instead of letting it block for the full
// top-level timeout (which, with auto-continue, stranded Madge for hours).
const SUBAGENT_INACTIVITY_TIMEOUT_MS = 600_000; // 10 min

interface Pending {
  resolve: (result: ChannelResponse) => void;
  scope: string;
  /** Original message text, kept for stale-session retry. */
  originalText: string;
  /** Original meta, kept for stale-session retry. */
  meta: SessionMeta;
  timeoutHandle: ReturnType<typeof setTimeout>;
  /** Optional callback for mid-turn partial text streaming. */
  onPartial?: (text: string) => void;
  /** Number of auto-continue retries already issued for this dispatch. */
  autoContinueRetries: number;
}

/** A peer message: optional platform lines, then the stamp only the orchestrator writes (text is escaped). */
const PEER_MESSAGE = /^(?:\[platform:[^\n]*\n)*\[peer: /;

export class OrchestratorBridge {
  /** correlationId → pending promise */
  private readonly pending = new Map<string, Pending>();
  /** scope → dispatches in flight (a turn is running while this is above zero). */
  private readonly inFlight = new Map<string, number>();
  /** scope → when its last turn ended (epoch ms, since this process started). */
  private readonly turnEnded = new Map<string, number>();
  /** Scopes running a turn nobody is waiting on (a follow-up, or a message queued during the reply). */
  private readonly unawaitedTurns = new Set<string>();
  /** Scopes whose CLI has background tasks running (the worker keeps it open for them). */
  private readonly liveTasks = new Set<string>();
  /** scope → messages a /sudo switch cut off; they go first into the scope's next dispatch. */
  private readonly interrupted = new Map<string, { texts: string[]; meta: Record<string, unknown> }>();
  /** A scope's turn started or ended (controller status events). */
  onTurnChange?: (scope: string) => void;
  /** Posts a follow-up (a result nobody is waiting on) to the scope's channel. */
  private followupHandler?: (scope: string, response: ChannelResponse) => void;

  constructor(
    readonly bus: EventBus,
    private readonly sessionManager: SessionManager,
    private readonly timeoutMs = 3_600_000,
  ) {}

  /**
   * Start listening to all worker events and lifecycle signals.
   * Must be called once after construction.
   */
  async start(): Promise<void> {
    await this.bus.subscribeAllEvents((scope, event) => {
      this.handleWorkerEvent(scope, event);
    });
    await this.bus.subscribeWorkerLifecycle((agentId) => {
      this.handleWorkerRestart(agentId).catch((err) =>
        console.error(`[bus] worker restart handling failed for ${agentId}:`, err)
      );
    });
    this.bus.startListening();
  }

  /**
   * Send a message to an agent and wait for the result.
   * Drop-in replacement for dispatchQueue.enqueue().
   */
  async sendAndWait(
    scope: string,
    text: string,
    meta: Record<string, unknown>,
  ): Promise<ChannelResponse> {
    const held = this.interrupted.get(scope);
    if (held) {
      this.interrupted.delete(scope);
      text = [...held.texts, text].filter(Boolean).join("\n\n");
    }
    // Every message goes straight to the worker: one arriving mid-turn is injected into the
    // running turn, whoever sent it (channel members are willing participants; the latest
    // sender's identity applies). The count is only for the busy/idle status peers shows.
    const turnStarts = !this.isTurnRunning(scope);
    this.inFlight.set(scope, (this.inFlight.get(scope) ?? 0) + 1);
    if (turnStarts) this.onTurnChange?.(scope);
    try {
      return await this.dispatch(scope, text, meta);
    } finally {
      const remaining = (this.inFlight.get(scope) ?? 1) - 1;
      if (remaining > 0) this.inFlight.set(scope, remaining);
      else {
        this.inFlight.delete(scope);
        this.turnEnded.set(scope, Date.now());
        this.onTurnChange?.(scope);
      }
    }
  }

  /** Would closing this scope's session now stop work: a turn, or a background task it started? */
  hasRunningWork(scope: string): boolean {
    if (!this.sessionManager.get(scope)) this.liveTasks.delete(scope);
    return this.isTurnRunning(scope) || this.liveTasks.has(scope);
  }

  /** Is a turn running in this scope (any dispatch in flight)? */
  isTurnRunning(scope: string): boolean {
    return (this.inFlight.get(scope) ?? 0) > 0 || this.unawaitedTurnRunning(scope);
  }

  private unawaitedTurnRunning(scope: string): boolean {
    if (!this.unawaitedTurns.has(scope)) return false;
    if (this.sessionManager.get(scope)) return true;
    this.unawaitedTurns.delete(scope);
    return false;
  }

  /** Scopes with a turn running right now. */
  busyScopes(): string[] {
    return [...new Set([...this.inFlight.keys(), ...[...this.unawaitedTurns].filter((scope) => this.unawaitedTurnRunning(scope))])];
  }

  /** When the scope's last turn ended (epoch ms), or null if none has since startup. */
  lastTurnEnded(scope: string): number | null {
    return this.turnEnded.get(scope) ?? null;
  }

  private async dispatch(
    scope: string,
    text: string,
    meta: Record<string, unknown>,
  ): Promise<ChannelResponse> {
    const sessionMeta: SessionMeta = {
      userId: (meta["userId"] as string) ?? "system",
      userPlatform: (meta["userPlatform"] as string) ?? "internal",
      askApproval: meta["askApproval"] as SessionMeta["askApproval"],
      askQuestions: meta["askQuestions"] as SessionMeta["askQuestions"],
      noSession: (meta["noSession"] as boolean) ?? false,
      ephemeral: (meta["ephemeral"] as boolean) ?? false,
      agentId: meta["agentId"] as string | undefined,
      parentCwd: meta["parentCwd"] as string | undefined,
      parentAgentId: meta["parentAgentId"] as string | undefined,
      forceParentCwd: meta["forceParentCwd"] as boolean | undefined,
      sudo: (meta["sudo"] as boolean | undefined) ?? false,
      hops: (meta["hops"] as number | undefined) ?? 0,
    };

    const attachments = meta["attachments"] as ChannelAttachment[] | undefined;
    const onPartial = meta["onPartial"] as ((text: string) => void) | undefined;
    const autoContinueRetries = (meta["_autoContinueRetries"] as number | undefined) ?? 0;

    // Ensure session exists (idempotent)
    const session = await this.sessionManager.ensureSession(scope, sessionMeta);

    // Save attachments and rewrite message text if needed.
    // Sandboxed agents see their workspace at /workspace (Docker mount), so
    // host paths under session.agentCwd must be translated before being
    // referenced in the prompt — otherwise the agent gets a path it cannot read.
    let promptText = text;
    if (attachments?.length) {
      const savedPaths = saveAttachmentsToDisk(attachments, session.agentCwd);
      const promptPaths = session.sandboxed
        ? savedPaths.map((p) => p.replace(session.agentCwd, "/workspace").replace(/\\/g, "/"))
        : savedPaths;
      promptText = buildPromptWithAttachments(text, attachments, promptPaths);
    }

    const correlationId = randomUUID();

    return new Promise<ChannelResponse>((resolve) => {
      const timeoutHandle = this.armTimeout(correlationId, scope);
      this.pending.set(correlationId, {
        resolve,
        scope,
        originalText: promptText,
        meta: sessionMeta,
        timeoutHandle,
        onPartial,
        autoContinueRetries,
      });

      const preview = promptText.slice(0, 80).replace(/\n/g, " ");
      log(`[bus] → ${session.agentId} | ${scope.slice(0, 40)} | "${preview}${promptText.length > 80 ? "…" : ""}"`);

      this.bus.publishMessage({
        kind: "user_message",
        correlationId,
        scope,
        text: promptText,
        userId: sessionMeta.userId,
        userPlatform: sessionMeta.userPlatform,
        timestamp: new Date().toISOString(),
      }).catch((err) => {
        // Redis publish failed — resolve with error
        clearTimeout(timeoutHandle);
        this.pending.delete(correlationId);
        resolve({ text: `Error: failed to publish message: ${err instanceof Error ? err.message : String(err)}` });
      });
    });
  }

  /**
   * Close a session by scope. Thin wrapper over SessionManager.closeSession
   * so callers (e.g. sub-agent lifecycle in agent-mcp) can release a scope
   * without reaching into the session manager directly.
   */
  async closeSession(scope: string, reason: string): Promise<void> {
    if (reason === "sudo_on" || reason === "sudo_off") this.holdUnanswered(scope, reason);
    await this.sessionManager.closeSession(scope, reason);
    this.unawaitedTurns.delete(scope);
    this.liveTasks.delete(scope);
  }

  /**
   * A /sudo switch ends the scope's turn and no result will come: settle its dispatches and
   * keep their messages for the next one, so none is lost and the scope doesn't show busy.
   * A peer's message never moves into a root session: its sender is told instead.
   */
  private holdUnanswered(scope: string, reason: "sudo_on" | "sudo_off"): void {
    for (const [cid, p] of this.pending) {
      if (p.scope !== scope) continue;
      clearTimeout(p.timeoutHandle);
      this.pending.delete(cid);
      if (reason === "sudo_on" && PEER_MESSAGE.test(p.originalText)) {
        p.resolve({ text: "", silent: true, dropped: "a person's message switched that conversation back to sudo mode and cut its turn off, so it may only have partly run" });
        continue;
      }
      const held = this.interrupted.get(scope) ?? { texts: [], meta: this.buildRetryMeta(p) };
      // Its mode note is out of date now; the switch brings its own.
      held.texts.push(p.originalText.replace(/^\[platform: sudo mode[^\n]*\n/, ""));
      this.interrupted.set(scope, held);
      p.resolve({ text: "", stopReason: "interrupted" });
    }
  }

  /** Does the scope have messages a /sudo switch cut off, waiting for a dispatch? */
  hasInterrupted(scope: string): boolean {
    return this.interrupted.has(scope);
  }

  /** Dispatch what a /sudo switch cut off, with no new message to carry it. The reply posts as a follow-up. */
  resumeInterrupted(scope: string, sudo: boolean, note: string): void {
    const held = this.interrupted.get(scope);
    if (!held) return;
    this.sendAndWait(scope, note, { ...held.meta, sudo }).then((response) => {
      if (!response.silent && (response.text.trim() || response.files?.length)) this.followupHandler?.(scope, response);
    }).catch((err) => console.error(`[bus] resuming ${scope.slice(0, 40)} failed:`, err));
  }

  /**
   * Deliver follow-ups: turns the agent takes after its reply, woken by a
   * background task it started finishing (see the worker's runAgentSession).
   */
  onFollowup(handler: (scope: string, response: ChannelResponse) => void): void {
    this.followupHandler = handler;
  }

  /** Graceful shutdown — clear pending promises and stop Redis. */
  async shutdown(): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timeoutHandle);
      p.resolve({ text: "Queue is shutting down." });
    }
    this.pending.clear();
    await this.bus.shutdown();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Called when a worker process publishes `worker:ready` on startup.
   *
   * The worker's Redis subscriptions are gone after a restart — any sessions
   * in the manager's Map for this agentId are stale. We:
   *   1. Collect pending promises whose scope belongs to this agentId.
   *   2. Close all stale sessions (removes from Map, releases concurrency slots).
   *   3. Retry the pending promises so they get fresh sessions + subscriptions.
   */
  private async handleWorkerRestart(agentId: string): Promise<void> {
    const scopes = this.sessionManager.getScopesByAgentId(agentId);
    if (scopes.size === 0) return;

    log(
      `[bus] worker:ready ${agentId} — invalidating ${scopes.size} stale session(s): ` +
      [...scopes].map((s) => s.slice(0, 30)).join(", "),
    );

    // Collect pending promises that need retrying before we close sessions
    const toRetry: Array<{ cid: string; p: Pending }> = [];
    for (const [cid, p] of this.pending) {
      if (scopes.has(p.scope)) {
        toRetry.push({ cid, p });
      }
    }

    // Close all stale sessions (may fail to reach dead worker — that's fine)
    await Promise.allSettled([...scopes].map((scope) =>
      this.sessionManager.closeSession(scope, "worker_restart")
    ));

    // Retry each pending promise with a fresh session
    for (const { cid, p } of toRetry) {
      clearTimeout(p.timeoutHandle);
      this.pending.delete(cid);
      this.sendAndWait(p.scope, p.originalText, this.buildRetryMeta(p)).then(p.resolve).catch(() =>
        p.resolve({ text: "Error: worker restarted during processing" })
      );
    }
  }

  /**
   * Arm (or re-arm) the dispatch timeout for a pending correlation. On expiry,
   * auto-continues a possibly-stuck dispatch. The timer is reset on every worker
   * turn (see evt:turn) so a dispatch that is actively making progress is never
   * declared timed-out — only a genuinely silent/hung dispatch trips it. This
   * prevents the spurious "continue" that, combined with an idle-close, used to
   * cold-boot a fresh, history-less session.
   */
  private armTimeout(correlationId: string, scope: string): ReturnType<typeof setTimeout> {
    const isSubagent = scope.startsWith("subagent:");
    const timeoutMs = isSubagent ? SUBAGENT_INACTIVITY_TIMEOUT_MS : this.timeoutMs;
    return setTimeout(() => {
      const p = this.pending.get(correlationId);
      if (!p) return; // already resolved
      this.pending.delete(correlationId);
      if (isSubagent) {
        // A wedged subagent can't be rescued by auto-continue — the injected
        // "continue" just queues behind the stuck turn and never runs. Free the
        // parent with a clean error and signal the worker to abort the scope so a
        // recovered tool call doesn't resume a zombie session.
        const mins = Math.round(timeoutMs / 60_000);
        log(`[bus] ⏱ subagent ${p.scope.slice(0, 38)} silent ${mins}m — wedged, failing dispatch`);
        if (p.meta.agentId) {
          this.bus.publishControl(p.meta.agentId, {
            kind: "control",
            action: "abort",
            scope: p.scope,
            reason: `inactivity ${mins}m`,
            timestamp: new Date().toISOString(),
          }).catch(() => {});
        }
        p.resolve({ text: `Error: subagent timed out — no activity for ${mins} min (likely a hung tool call). Parent freed; retry or proceed without it.` });
        return;
      }
      if (p.autoContinueRetries < MAX_AUTO_CONTINUE) {
        const attempt = p.autoContinueRetries + 1;
        log(`[bus] ⏱ timeout ${p.scope.slice(0, 30)} — auto-continuing (${attempt}/${MAX_AUTO_CONTINUE})`);
        const continueMeta = { ...this.buildRetryMeta(p), _autoContinueRetries: attempt };
        // A live session may just be slow: nudge it. With none left, its turn is gone: send the message again.
        const retryText = this.sessionManager.get(p.scope) ? "continue" : p.originalText;
        this.sendAndWait(p.scope, retryText, continueMeta).then(p.resolve).catch(() =>
          p.resolve({ text: "Error: dispatch timed out" })
        );
      } else {
        p.resolve({ text: "Error: dispatch timed out" });
      }
    }, timeoutMs);
  }

  /**
   * Build the meta to use for a retried dispatch (worker_restart, auto-continue, /sudo
   * switch or stale_session).
   * Forwards the FULL original SessionMeta — dropping `agentId`, `parentAgentId`,
   * `parentCwd`, or `forceParentCwd` causes inline subagents to be re-dispatched
   * as standalone, hitting the wrong worker container and creating dual workers
   * for the same scope (root cause of "Unknown callback token" failures).
   *
   * By default the retry resumes the scope's conversation, as the original would: a fresh
   * session there has no history, and its reply lands in a transcript the app doesn't read.
   * The stale_session path passes `fresh`: there the old binding is dead, so it starts a new
   * session and MUST persist its id, or the scope re-resumes the dead id on every future
   * message (permanent history-less cold-loop).
   */
  private buildRetryMeta(p: Pending, fresh = false): Record<string, unknown> {
    return {
      userId: p.meta.userId,
      userPlatform: p.meta.userPlatform,
      askApproval: p.meta.askApproval,
      askQuestions: p.meta.askQuestions,
      agentId: p.meta.agentId,
      parentCwd: p.meta.parentCwd,
      parentAgentId: p.meta.parentAgentId,
      forceParentCwd: p.meta.forceParentCwd,
      sudo: p.meta.sudo,
      hops: p.meta.hops,
      noSession: fresh ? true : p.meta.noSession,
      ephemeral: fresh ? false : p.meta.ephemeral,
      onPartial: p.onPartial,
    };
  }

  private endUnawaitedTurn(scope: string): void {
    if (!this.unawaitedTurns.delete(scope)) return;
    this.turnEnded.set(scope, Date.now());
    this.onTurnChange?.(scope);
  }

  private handleWorkerEvent(scope: string, event: BusWorkerEvent): void {
    switch (event.kind) {
      case "evt:started":
        this.sessionManager.updateSdkSessionId(scope, event.sdkSessionId);
        break;

      case "evt:turn": {
        // Worker made progress. Refresh the session idle timer and reset the
        // dispatch timeout(s) for this scope, so an actively-working session is
        // never idle-closed or declared timed-out mid-task (which previously
        // raced into a cold, history-less session — see armTimeout / touch).
        this.sessionManager.touch(scope);
        let awaited = false;
        for (const [cid, p] of this.pending) {
          if (p.scope !== scope) continue;
          awaited = true;
          clearTimeout(p.timeoutHandle);
          p.timeoutHandle = this.armTimeout(cid, p.scope);
        }
        if (!awaited && !this.unawaitedTurns.has(scope)) {
          this.unawaitedTurns.add(scope);
          this.onTurnChange?.(scope);
        }
        const parts = [`${event.input}in/${event.output}out`];
        if (event.cacheRead > 0) parts.push(`cache_read:${event.cacheRead}`);
        if (event.cacheCreate > 0) parts.push(`cache_create:${event.cacheCreate}`);
        log(`[bus] ${scope.slice(0, 30)} turn ${event.turns}: ${parts.join(" ")}`);
        break;
      }

      case "evt:tasks":
        if (event.live > 0) this.liveTasks.add(scope);
        else this.liveTasks.delete(scope);
        break;

      case "evt:tool_start":
        log(`[bus] ${scope.slice(0, 30)} tool: ${event.toolName}`);
        break;

      case "evt:tool_end":
        log(`[bus] ${scope.slice(0, 30)} tool done: ${event.elapsedMs}ms`);
        break;

      case "evt:assistant_text": {
        // Stream mid-turn assistant text once per scope, regardless of how
        // many pending promises exist. Mid-turn injections produce multiple
        // pendings for the same scope, but they all target the same channel
        // — calling onPartial on each would post the text N times.
        let streamer: Pending | undefined;
        for (const p of this.pending.values()) {
          if (p.scope !== scope) continue;
          if (p.onPartial) { streamer = p; break; }
        }
        if (streamer?.onPartial) {
          try { streamer.onPartial(event.text); } catch (err) {
            console.error(`[bus] onPartial threw for ${scope.slice(0, 30)}:`, err);
          }
        }
        break;
      }

      case "evt:result": {
        this.endUnawaitedTurn(scope);
        const p = this.pending.get(event.correlationId);
        const preview = event.text.slice(0, 100).replace(/\n/g, " ");
        const emptyMark = event.silent ? " (silent: no_reply)" : event.text.length === 0 ? " ⚠ EMPTY" : "";
        const followMark = event.followup ? " (follow-up)" : "";
        log(`[bus] ← ${scope.slice(0, 30)} | session=${event.sdkSessionId.slice(0, 12)} | stop=${event.stopReason} | "${preview}${event.text.length > 100 ? "…" : ""}"${emptyMark}${followMark}`);

        if (event.followup) {
          // Nobody is waiting on it: post it as a new message, or nothing if empty.
          if (!event.silent && (event.text.trim() || event.files?.length)) {
            this.followupHandler?.(scope, { text: event.text, files: event.files, stopReason: event.stopReason });
          }
          break;
        }

        // Guard: if the correlationId has no pending (e.g. stale-session recovery
        // already consumed it), do NOT coalesce — other pendings for this scope
        // may be legitimate retries waiting for their own results.
        if (!p) break;

        // Coalesce injected messages: any other pending promises for the same
        // scope were mid-turn injections. The agent addressed them all in one
        // reply, so resolve the coalesced ones with empty text — the channel
        // adapter posts the reply for the original correlationId only,
        // avoiding N duplicate Discord messages for N injected user messages.
        for (const [cid, op] of this.pending) {
          if (op.scope === scope && cid !== event.correlationId) {
            clearTimeout(op.timeoutHandle);
            this.pending.delete(cid);
            op.resolve({ text: "", stopReason: event.stopReason });
          }
        }
        clearTimeout(p.timeoutHandle);
        this.pending.delete(event.correlationId);
        p.resolve({ text: event.text, files: event.files, stopReason: event.stopReason, ...(event.silent ? { silent: true } : {}) });
        break;
      }

      case "evt:error": {
        this.endUnawaitedTurn(scope);
        const p = this.pending.get(event.correlationId);
        if (!p) break;
        clearTimeout(p.timeoutHandle);
        this.pending.delete(event.correlationId);
        log(`[bus] ✗ ${scope.slice(0, 30)} error: ${event.message}`);
        p.resolve({ text: `Error: ${event.message}` });
        break;
      }

      case "evt:stale_session": {
        const p = this.pending.get(event.correlationId);
        if (!p) break;
        // Reset session (clears SDK session ID) and retry the same message
        log(`[bus] stale session on ${scope.slice(0, 30)} — resetting and retrying`);
        this.sessionManager.resetSdkSession(scope).then(() => {
          // Close the old session so ensureSession recreates it fresh
          return this.sessionManager.closeSession(scope, "stale_session");
        }).then(() => {
          clearTimeout(p.timeoutHandle);
          this.pending.delete(event.correlationId);
          // Re-dispatch via sendAndWait — preserves full meta so inline subagents
          // are not silently downgraded to standalone (which would fork a second
          // worker for the same scope and produce "Unknown callback token" errors).
          // persistRecovery=true: the old binding is dead (that's why it went
          // stale), so the fresh session's id MUST be written back to sessions.db
          // or this scope re-resumes the dead id forever (history-less cold-loop).
          return this.sendAndWait(scope, p.originalText, this.buildRetryMeta(p, true));
        }).then((result) => {
          p.resolve(result);
        }).catch((err) => {
          p.resolve({ text: `Error: stale session retry failed: ${err instanceof Error ? err.message : String(err)}` });
        });
        break;
      }
    }
  }
}
