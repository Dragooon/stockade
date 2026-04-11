/**
 * WorkerSession — manages one running agent query() loop.
 *
 * Two modes:
 *
 * start() — Original SSE-backed mode: takes an initial prompt, runs query(),
 *   emits events to local subscribers (SSE). Session is done after one result.
 *
 * startPersistent() — Redis-backed mode: subscribes to stockade:msg:{scope}
 *   on Redis, processes messages one at a time (sequential, with SDK resume),
 *   publishes events to Redis. Session stays alive until abort() is called.
 */

import { readFile } from "node:fs/promises";
import { ConversationChannel } from "./channel.js";
import type { WorkerSessionRequest, WorkerEvent } from "./types.js";
import { runAgentSession } from "./agent.js";
import type { WorkerRedisBridge } from "./redis-bridge.js";
import type { BusWorkerEvent } from "./bus-types.js";

export type EventListener = (event: WorkerEvent) => void;

export class WorkerSession {
  private readonly channel = new ConversationChannel();
  private readonly eventBuffer: WorkerEvent[] = [];
  private readonly listeners: EventListener[] = [];
  private _done = false;

  // Persistent-mode state
  private _aborted = false;
  private _wakeLoop: (() => void) | null = null;

  get done(): boolean {
    return this._done || this._aborted;
  }

  /**
   * Register a listener and immediately drain all buffered events.
   * After draining, the listener will receive future events in real time.
   */
  subscribe(listener: EventListener): void {
    for (const ev of this.eventBuffer) {
      listener(ev);
    }
    this.listeners.push(listener);
  }

  /** Emit an event — buffers it and forwards to all subscribers. */
  private emit(event: WorkerEvent): void {
    this.eventBuffer.push(event);
    for (const l of this.listeners) l(event);
    if (event.type === "result" || event.type === "error" || event.type === "stale_session") {
      this._done = true;
      this.channel.close();
    }
  }

  /**
   * Push a follow-up message into the running query() loop (SSE mode).
   * In Redis mode, messages arrive via Redis subscription — use startPersistent().
   */
  inject(text: string): void {
    this.channel.push(text);
  }

  /** Abort the session. Works for both SSE and persistent mode. */
  abort(): void {
    this._aborted = true;
    this._done = true;
    this.channel.close();
    // Wake the persistent loop if it's waiting for the next message
    const wake = this._wakeLoop;
    this._wakeLoop = null;
    wake?.();
  }

  // ── SSE mode ─────────────────────────────────────────────────────────────

  /**
   * Start the agent loop in the background (SSE mode).
   * Push the initial message and begin the async agent iteration.
   */
  start(request: WorkerSessionRequest): void {
    this.channel.push(request.prompt);

    runAgentSession(request, this.channel, (ev) => {
      if (ev.type === "started") {
        this.channel.setSessionId(ev.sessionId);
      }
      this.emit(ev);
    }).catch((err) => {
      this.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ── Persistent / Redis mode ──────────────────────────────────────────────

  /**
   * Start the persistent session loop (Redis mode).
   *
   * Subscribes to stockade:msg:{scope} on Redis. For each arriving message,
   * runs one query() call (resuming the SDK session) and publishes the result
   * to stockade:evt:{scope}. Loops until abort() is called.
   */
  startPersistent(request: WorkerSessionRequest, bridge: WorkerRedisBridge): void {
    void this.runPersistentLoop(request, bridge);
  }

  private async runPersistentLoop(
    request: WorkerSessionRequest,
    bridge: WorkerRedisBridge,
  ): Promise<void> {
    const scope = request.scope!;
    let currentSessionId: string | null = request.sessionId ?? null;

    // Pending messages queue — decoupled from the ConversationChannel so that
    // a stale SDK iterator from a previous query() call cannot consume messages
    // meant for the next query. A fresh ConversationChannel is created per query.
    const pendingMessages: string[] = [];

    // Active channel for the currently running query — non-null only while
    // queryRunning is true. Mid-turn arrivals are injected here directly.
    let activeChannel: ConversationChannel | null = null;

    // Track whether a query() is currently running.
    let queryRunning = false;
    // correlationId of the most recently received message.
    let currentCorrelationId = "";

    await bridge.subscribeScope(scope, (msg) => {
      currentCorrelationId = msg.correlationId;
      if (queryRunning && activeChannel && !activeChannel.closed) {
        // Mid-turn injection: push into the running query's channel so the agent
        // sees the message before producing its result. Update correlationId so
        // the result is attributed to this (last) message.
        console.log(`[worker] msg received (mid-turn) cid=${msg.correlationId.slice(0, 8)}`);
        activeChannel.push(msg.text);
      } else {
        // No query running — enqueue and wake the idle loop.
        pendingMessages.push(msg.text);
        console.log(`[worker] msg received (idle) cid=${msg.correlationId.slice(0, 8)} wakeLoop=${this._wakeLoop != null} pending=${pendingMessages.length}`);
        const wake = this._wakeLoop;
        this._wakeLoop = null;
        wake?.();
      }
    });

    console.log(`[worker] Persistent session loop started for scope ${scope.slice(0, 40)}`);

    while (!this._aborted) {
      // Wait until there is at least one pending message.
      if (pendingMessages.length === 0) {
        await new Promise<void>((resolve) => {
          this._wakeLoop = resolve;
        });
      }
      if (this._aborted) break;
      if (pendingMessages.length === 0) continue;

      // Snapshot correlationId at query start.
      const queryCorrelationId = currentCorrelationId;
      console.log(`[worker] starting query cid=${queryCorrelationId.slice(0, 8)} pending=${pendingMessages.length}`);

      // Fresh channel per query — prevents a stale SDK read-ahead iterator from
      // consuming the first message of the next query out of the buffer.
      const queryChannel = new ConversationChannel();
      activeChannel = queryChannel;

      // Drain all pending messages into the channel before starting the query.
      while (pendingMessages.length > 0) {
        queryChannel.push(pendingMessages.shift()!);
      }

      queryRunning = true;

      const emit = (ev: WorkerEvent) => {
        if (ev.type === "started") {
          queryChannel.setSessionId(ev.sessionId);
          currentSessionId = ev.sessionId;
        }

        // For result events with files, embed base64 content so the orchestrator
        // can deliver them even when the agent runs in a sandboxed container whose
        // filesystem is not accessible from the host.
        if (ev.type === "result" && ev.files && ev.files.length > 0) {
          Promise.all(
            ev.files.map(async (f) => ({
              ...f,
              // Skip readFile when content is already embedded (e.g. propagated from sub-agent)
              content: f.content ?? await readFile(f.path).then((buf) => buf.toString("base64")).catch(() => undefined),
            })),
          ).then((filesWithContent) => {
            const busEvent = mapToBusEvent({ ...ev, files: filesWithContent }, scope, queryCorrelationId);
            if (!busEvent) return;
            bridge.publishEvent(scope, busEvent).catch((err) => {
              console.error(`[worker] Failed to publish event for ${scope}:`, err.message);
            });
          }).catch(() => {
            // Fall back to publishing without content on read error
            const busEvent = mapToBusEvent(ev, scope, queryCorrelationId);
            if (!busEvent) return;
            bridge.publishEvent(scope, busEvent).catch(() => {});
          });
          return;
        }

        const busEvent = mapToBusEvent(ev, scope, queryCorrelationId);
        if (!busEvent) return;
        bridge.publishEvent(scope, busEvent).catch((err) => {
          console.error(`[worker] Failed to publish event for ${scope}:`, err.message);
        });
      };

      const queryRequest: WorkerSessionRequest = {
        ...request,
        prompt: "", // channel is the source — prompt field unused
        sessionId: currentSessionId ?? undefined,
        forceNewSession: !currentSessionId,
      };

      try {
        await runAgentSession(queryRequest, queryChannel, emit);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[worker] Query failed for scope ${scope.slice(0, 40)}:`, errMsg);
        bridge.publishEvent(scope, {
          kind: "evt:error",
          scope,
          correlationId: queryCorrelationId,
          message: errMsg,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      } finally {
        queryRunning = false;
        activeChannel = null;
        queryChannel.close(); // Terminate any lingering SDK read-ahead iterator.
      }
    }
    await bridge.unsubscribeScope(scope).catch(() => {});
    console.log(`[worker] Persistent session loop ended for scope ${scope.slice(0, 40)}`);
  }
}

// ── Event mapping ────────────────────────────────────────────────────────────

function mapToBusEvent(
  ev: WorkerEvent,
  scope: string,
  correlationId: string,
): BusWorkerEvent | null {
  const ts = new Date().toISOString();
  switch (ev.type) {
    case "started":
      return { kind: "evt:started", scope, correlationId, sdkSessionId: ev.sessionId, timestamp: ts };
    case "turn":
      return {
        kind: "evt:turn",
        scope,
        correlationId,
        turns: ev.turns,
        input: ev.input,
        output: ev.output,
        cacheRead: ev.cacheRead,
        cacheCreate: ev.cacheCreate,
        timestamp: ts,
      };
    case "tool_start":
      return { kind: "evt:tool_start", scope, correlationId, toolName: ev.name, timestamp: ts };
    case "tool_end":
      return { kind: "evt:tool_end", scope, correlationId, toolName: ev.name, elapsedMs: ev.elapsedMs, timestamp: ts };
    case "result":
      return {
        kind: "evt:result",
        scope,
        correlationId,
        text: ev.text,
        sdkSessionId: ev.sessionId,
        stopReason: ev.stopReason,
        files: ev.files,
        timestamp: ts,
      };
    case "error":
      return { kind: "evt:error", scope, correlationId, message: ev.message, timestamp: ts };
    case "stale_session":
      return { kind: "evt:stale_session", scope, correlationId, timestamp: ts };
    default:
      return null;
  }
}
