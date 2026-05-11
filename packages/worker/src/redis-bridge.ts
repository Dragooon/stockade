/**
 * WorkerRedisBridge — Redis pub/sub client for the worker.
 *
 * The worker subscribes to stockade:msg:{scope} for incoming user messages
 * and publishes to stockade:evt:{scope} for events back to the orchestrator.
 * Control signals (reset_session, shutdown, abort) arrive on stockade:ctl:{agentId}.
 *
 * One bridge instance per worker process, shared across all sessions.
 */

import Redis from "ioredis";
import type { BusUserMessage, BusControlSignal, BusWorkerEvent } from "./bus-types.js";

export type ScopeHandler = (msg: BusUserMessage) => void;

export class WorkerRedisBridge {
  private readonly pub: Redis;
  private readonly sub: Redis;
  /**
   * Maps Redis channel names to message handlers. Multi-handler per channel:
   * if a stale WorkerSession is still tearing down while a fresh one for the
   * same scope is created (e.g. stale_session retry against an inline subagent),
   * both end up subscribed transiently. A single-handler map would lose the
   * old handler — and if the unsubscribe order races, lose the channel too.
   */
  private readonly scopeHandlers = new Map<string, ScopeHandler[]>();
  /** Control signal handlers (one per subscribeControl call). */
  private readonly controlHandlers: Array<(signal: BusControlSignal) => void> = [];
  private controlChannel: string | null = null;

  constructor(readonly redisUrl: string) {
    this.pub = new Redis(redisUrl, { lazyConnect: false, enableReadyCheck: false });
    this.sub = new Redis(redisUrl, { lazyConnect: false, enableReadyCheck: false });

    this.sub.on("message", (channel: string, data: string) => {
      const handlers = this.scopeHandlers.get(channel);
      if (handlers && handlers.length) {
        let parsed: BusUserMessage;
        try { parsed = JSON.parse(data) as BusUserMessage; } catch { return; }
        for (const h of handlers) {
          try { h(parsed); } catch { /* ignore */ }
        }
        return;
      }
      if (channel === this.controlChannel && this.controlHandlers.length) {
        try {
          const signal = JSON.parse(data) as BusControlSignal;
          for (const h of this.controlHandlers) h(signal);
        } catch { /* ignore */ }
      }
    });
  }

  /** Subscribe to incoming user messages for a scope. */
  async subscribeScope(scope: string, handler: ScopeHandler): Promise<void> {
    const channel = `stockade:msg:${scope}`;
    let handlers = this.scopeHandlers.get(channel);
    if (!handlers) {
      handlers = [];
      this.scopeHandlers.set(channel, handlers);
    }
    handlers.push(handler);
    if (handlers.length === 1) {
      await this.sub.subscribe(channel);
    }
    console.log(`[worker-redis] subscribed to ${channel} (handlers=${handlers.length})`);
  }

  /**
   * Unsubscribe from a scope's message channel. Removes only the specific
   * handler if provided; the Redis subscription drops only when the last
   * handler for the channel is gone.
   */
  async unsubscribeScope(scope: string, handler?: ScopeHandler): Promise<void> {
    const channel = `stockade:msg:${scope}`;
    const handlers = this.scopeHandlers.get(channel);
    if (!handlers) return;
    if (handler) {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    } else {
      handlers.length = 0;
    }
    if (handlers.length > 0) return;
    this.scopeHandlers.delete(channel);
    await this.sub.unsubscribe(channel).catch(() => {});
  }

  /** Publish a worker event to the orchestrator. */
  async publishEvent(scope: string, event: BusWorkerEvent): Promise<void> {
    const channel = `stockade:evt:${scope}`;
    await this.pub.publish(channel, JSON.stringify(event)).catch((err) => {
      console.error(`[worker-redis] publish failed on ${channel}:`, err.message);
    });
  }

  /** Subscribe to control signals for this agent. */
  async subscribeControl(agentId: string, handler: (signal: BusControlSignal) => void): Promise<void> {
    this.controlHandlers.push(handler);
    if (!this.controlChannel) {
      this.controlChannel = `stockade:ctl:${agentId}`;
      await this.sub.subscribe(this.controlChannel);
      console.log(`[worker-redis] subscribed to control channel ${this.controlChannel}`);
    }
  }

  /**
   * Announce to the orchestrator that this worker process is ready.
   * Called once after the HTTP server starts listening.
   * The orchestrator uses this to invalidate stale sessions and retry
   * any pending messages that were lost when the previous worker process died.
   */
  async publishReady(agentId: string): Promise<void> {
    await this.pub.publish(`stockade:worker:${agentId}`, JSON.stringify({
      kind: "worker:ready",
      agentId,
      timestamp: new Date().toISOString(),
    }));
    console.log(`[worker-redis] published ready signal for agent=${agentId}`);
  }

  async shutdown(): Promise<void> {
    await this.sub.quit().catch(() => {});
    await this.pub.quit().catch(() => {});
  }
}
