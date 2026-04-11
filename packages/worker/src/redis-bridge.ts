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

export class WorkerRedisBridge {
  private readonly pub: Redis;
  private readonly sub: Redis;
  /** Maps Redis channel names to message handlers. */
  private readonly scopeHandlers = new Map<string, (msg: BusUserMessage) => void>();
  /** Control signal handlers (one per subscribeControl call). */
  private readonly controlHandlers: Array<(signal: BusControlSignal) => void> = [];
  private controlChannel: string | null = null;

  constructor(readonly redisUrl: string) {
    this.pub = new Redis(redisUrl, { lazyConnect: false, enableReadyCheck: false });
    this.sub = new Redis(redisUrl, { lazyConnect: false, enableReadyCheck: false });

    this.sub.on("message", (channel: string, data: string) => {
      const scopeHandler = this.scopeHandlers.get(channel);
      if (scopeHandler) {
        try { scopeHandler(JSON.parse(data) as BusUserMessage); } catch { /* ignore */ }
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
  async subscribeScope(scope: string, handler: (msg: BusUserMessage) => void): Promise<void> {
    const channel = `stockade:msg:${scope}`;
    this.scopeHandlers.set(channel, handler);
    await this.sub.subscribe(channel);
    console.log(`[worker-redis] subscribed to ${channel}`);
  }

  /** Unsubscribe from a scope's message channel. */
  async unsubscribeScope(scope: string): Promise<void> {
    const channel = `stockade:msg:${scope}`;
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
