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

export class OrchestratorBridge {
  /** correlationId → pending promise */
  private readonly pending = new Map<string, Pending>();

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
    const sessionMeta: SessionMeta = {
      userId: (meta["userId"] as string) ?? "system",
      userPlatform: (meta["userPlatform"] as string) ?? "internal",
      askApproval: meta["askApproval"] as SessionMeta["askApproval"],
      noSession: (meta["noSession"] as boolean) ?? false,
      agentId: meta["agentId"] as string | undefined,
      parentCwd: meta["parentCwd"] as string | undefined,
      parentAgentId: meta["parentAgentId"] as string | undefined,
      forceParentCwd: meta["forceParentCwd"] as boolean | undefined,
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
      const timeoutHandle = setTimeout(() => {
        const p = this.pending.get(correlationId);
        if (!p) return; // already resolved
        this.pending.delete(correlationId);
        if (p.autoContinueRetries < MAX_AUTO_CONTINUE) {
          const attempt = p.autoContinueRetries + 1;
          log(`[bus] ⏱ timeout ${scope.slice(0, 30)} — auto-continuing (${attempt}/${MAX_AUTO_CONTINUE})`);
          const continueMeta = { ...this.buildRetryMeta(p), _autoContinueRetries: attempt };
          this.sendAndWait(p.scope, "continue", continueMeta).then(resolve).catch(() =>
            resolve({ text: "Error: dispatch timed out" })
          );
        } else {
          resolve({ text: "Error: dispatch timed out" });
        }
      }, this.timeoutMs);

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
    await this.sessionManager.closeSession(scope, reason);
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
   * Build the meta to use for a retried dispatch (worker_restart or stale_session).
   * Forwards the FULL original SessionMeta — dropping `agentId`, `parentAgentId`,
   * `parentCwd`, or `forceParentCwd` causes inline subagents to be re-dispatched
   * as standalone, hitting the wrong worker container and creating dual workers
   * for the same scope (root cause of "Unknown callback token" failures).
   */
  private buildRetryMeta(p: Pending): Record<string, unknown> {
    return {
      userId: p.meta.userId,
      userPlatform: p.meta.userPlatform,
      askApproval: p.meta.askApproval,
      agentId: p.meta.agentId,
      parentCwd: p.meta.parentCwd,
      parentAgentId: p.meta.parentAgentId,
      forceParentCwd: p.meta.forceParentCwd,
      noSession: true, // don't try to resume the SDK session
      onPartial: p.onPartial,
    };
  }

  private handleWorkerEvent(scope: string, event: BusWorkerEvent): void {
    switch (event.kind) {
      case "evt:started":
        this.sessionManager.updateSdkSessionId(scope, event.sdkSessionId);
        break;

      case "evt:turn": {
        const parts = [`${event.input}in/${event.output}out`];
        if (event.cacheRead > 0) parts.push(`cache_read:${event.cacheRead}`);
        if (event.cacheCreate > 0) parts.push(`cache_create:${event.cacheCreate}`);
        log(`[bus] ${scope.slice(0, 30)} turn ${event.turns}: ${parts.join(" ")}`);
        break;
      }

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
        // — calling onPartial on each would post the text N times. Mark only
        // the chosen streamer as streamed; pendings without onPartial (e.g.
        // scheduler dispatches) must still receive the final result text,
        // and other coalesced pendings get suppressed by the result handler.
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
        const p = this.pending.get(event.correlationId);
        const preview = event.text.slice(0, 100).replace(/\n/g, " ");
        const emptyMark = event.text.length === 0 ? " ⚠ EMPTY" : "";
        log(`[bus] ← ${scope.slice(0, 30)} | session=${event.sdkSessionId.slice(0, 12)} | stop=${event.stopReason} | "${preview}${event.text.length > 100 ? "…" : ""}"${emptyMark}`);

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

        if (!p) break;
        clearTimeout(p.timeoutHandle);
        this.pending.delete(event.correlationId);
        p.resolve({ text: event.text, files: event.files, stopReason: event.stopReason });
        break;
      }

      case "evt:error": {
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
          return this.sendAndWait(scope, p.originalText, this.buildRetryMeta(p));
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
