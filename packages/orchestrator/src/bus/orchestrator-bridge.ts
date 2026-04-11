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

interface Pending {
  resolve: (result: ChannelResponse) => void;
  scope: string;
  /** Original message text, kept for stale-session retry. */
  originalText: string;
  /** Original meta, kept for stale-session retry. */
  meta: SessionMeta;
  timeoutHandle: ReturnType<typeof setTimeout>;
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
      forceParentCwd: meta["forceParentCwd"] as boolean | undefined,
    };

    const attachments = meta["attachments"] as ChannelAttachment[] | undefined;

    // Ensure session exists (idempotent)
    const session = await this.sessionManager.ensureSession(scope, sessionMeta);

    // Save attachments and rewrite message text if needed
    let promptText = text;
    if (attachments?.length) {
      const savedPaths = saveAttachmentsToDisk(attachments, session.agentCwd);
      promptText = buildPromptWithAttachments(text, attachments, savedPaths);
    }

    const correlationId = randomUUID();

    return new Promise<ChannelResponse>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(correlationId);
        resolve({ text: "Error: dispatch timed out" });
      }, this.timeoutMs);

      this.pending.set(correlationId, {
        resolve,
        scope,
        originalText: promptText,
        meta: sessionMeta,
        timeoutHandle,
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
      this.sendAndWait(p.scope, p.originalText, {
        userId: p.meta.userId,
        userPlatform: p.meta.userPlatform,
        askApproval: p.meta.askApproval,
        noSession: true,
      }).then(p.resolve).catch(() =>
        p.resolve({ text: "Error: worker restarted during processing" })
      );
    }
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

      case "evt:result": {
        const p = this.pending.get(event.correlationId);
        const preview = event.text.slice(0, 100).replace(/\n/g, " ");
        log(`[bus] ← ${scope.slice(0, 30)} | session=${event.sdkSessionId.slice(0, 12)} | "${preview}${event.text.length > 100 ? "…" : ""}"`);

        // Coalesce injected messages: any other pending promises for the same
        // scope were mid-turn injections. The agent addressed them all in one
        // reply, so resolve them with the same text.
        for (const [cid, op] of this.pending) {
          if (op.scope === scope && cid !== event.correlationId) {
            clearTimeout(op.timeoutHandle);
            this.pending.delete(cid);
            op.resolve({ text: event.text, files: event.files });
          }
        }

        if (!p) break;
        clearTimeout(p.timeoutHandle);
        this.pending.delete(event.correlationId);
        p.resolve({ text: event.text, files: event.files });
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
          // Re-dispatch via sendAndWait (will create a fresh session)
          return this.sendAndWait(scope, p.originalText, {
            userId: p.meta.userId,
            userPlatform: p.meta.userPlatform,
            askApproval: p.meta.askApproval,
            noSession: true, // don't try to resume again
          });
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
