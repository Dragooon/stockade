/**
 * EventBus — Redis pub/sub wrapper for the Stockade dispatch bus.
 *
 * Uses two ioredis clients (Redis requires separate connections for pub and sub).
 * Publishes messages/control signals and subscribes to worker events.
 * Also manages session state in Redis hashes with TTL-based idle expiry.
 */

import Redis from "ioredis";
import { msgChannel, evtChannel, ctlChannel, EVT_PATTERN, WORKER_PATTERN, scopeFromChannel } from "./channels.js";
import type { BusUserMessage, BusWorkerEvent, BusControlSignal, BusSessionInfo, BusWorkerLifecycle } from "./types.js";

export interface EventBusConfig {
  /** Redis connection URL. Default: "redis://localhost:6379" */
  redisUrl?: string;
  /** Key prefix for session state hashes. Default: "stockade:session:" */
  sessionPrefix?: string;
  /** Session idle TTL in seconds. Default: 3600 */
  sessionIdleTimeoutSec?: number;
}

export class EventBus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly sessionPrefix: string;
  readonly sessionIdleTimeoutSec: number;

  /** Per-scope event handlers registered via subscribeEvents(). */
  private readonly scopeHandlers = new Map<string, Array<(event: BusWorkerEvent) => void>>();
  /** Global pattern handlers registered via subscribeAllEvents(). */
  private readonly patternHandlers: Array<(scope: string, event: BusWorkerEvent) => void> = [];
  /** Worker lifecycle handlers registered via subscribeWorkerLifecycle(). */
  private readonly workerLifecycleHandlers: Array<(agentId: string, event: BusWorkerLifecycle) => void> = [];

  constructor(readonly config: EventBusConfig = {}) {
    const url = config.redisUrl ?? "redis://localhost:6379";
    this.pub = new Redis(url, { lazyConnect: false });
    this.sub = new Redis(url, { lazyConnect: false });
    this.sessionPrefix = config.sessionPrefix ?? "stockade:session:";
    this.sessionIdleTimeoutSec = config.sessionIdleTimeoutSec ?? 3600;
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  async publishMessage(msg: BusUserMessage): Promise<void> {
    await this.pub.publish(msgChannel(msg.scope), JSON.stringify(msg));
  }

  async publishControl(agentId: string, signal: BusControlSignal): Promise<void> {
    await this.pub.publish(ctlChannel(agentId), JSON.stringify(signal));
  }

  async publishEvent(scope: string, event: BusWorkerEvent): Promise<void> {
    await this.pub.publish(evtChannel(scope), JSON.stringify(event));
  }

  // ── Subscribe ─────────────────────────────────────────────────────────────

  /** Subscribe to events for a specific scope. */
  async subscribeEvents(scope: string, handler: (event: BusWorkerEvent) => void): Promise<void> {
    const channel = evtChannel(scope);
    let handlers = this.scopeHandlers.get(channel);
    if (!handlers) {
      handlers = [];
      this.scopeHandlers.set(channel, handlers);
      await this.sub.subscribe(channel);
    }
    handlers.push(handler);
  }

  /** Unsubscribe from events for a specific scope. */
  async unsubscribeEvents(scope: string): Promise<void> {
    const channel = evtChannel(scope);
    if (this.scopeHandlers.has(channel)) {
      this.scopeHandlers.delete(channel);
      await this.sub.unsubscribe(channel).catch(() => {});
    }
  }

  /** Subscribe to ALL worker events via pattern (orchestrator-wide listener). */
  async subscribeAllEvents(handler: (scope: string, event: BusWorkerEvent) => void): Promise<void> {
    if (this.patternHandlers.length === 0) {
      await this.sub.psubscribe(EVT_PATTERN);
    }
    this.patternHandlers.push(handler);
  }

  /** Subscribe to worker lifecycle signals (worker:ready) for all agents. */
  async subscribeWorkerLifecycle(handler: (agentId: string, event: BusWorkerLifecycle) => void): Promise<void> {
    if (this.workerLifecycleHandlers.length === 0) {
      await this.sub.psubscribe(WORKER_PATTERN);
    }
    this.workerLifecycleHandlers.push(handler);
  }

  /**
   * Start the Redis message listener. Call once after all subscriptions are set up.
   * Wires the ioredis "message" and "pmessage" events to registered handlers.
   */
  startListening(): void {
    this.sub.on("message", (channel: string, data: string) => {
      const handlers = this.scopeHandlers.get(channel);
      if (handlers?.length) {
        try {
          const event = JSON.parse(data) as BusWorkerEvent;
          for (const h of handlers) h(event);
        } catch {
          // Malformed event — ignore
        }
      }
    });

    this.sub.on("pmessage", (_pattern: string, channel: string, data: string) => {
      if (channel.startsWith("stockade:worker:") && this.workerLifecycleHandlers.length) {
        try {
          const agentId = channel.slice("stockade:worker:".length);
          const event = JSON.parse(data) as BusWorkerLifecycle;
          for (const h of this.workerLifecycleHandlers) h(agentId, event);
        } catch {
          // Malformed lifecycle event — ignore
        }
        return;
      }
      if (this.patternHandlers.length > 0) {
        try {
          const scope = scopeFromChannel(channel);
          const event = JSON.parse(data) as BusWorkerEvent;
          for (const h of this.patternHandlers) h(scope, event);
        } catch {
          // Malformed event — ignore
        }
      }
    });
  }

  // ── Session state ─────────────────────────────────────────────────────────

  private sessionKey(scope: string): string {
    return `${this.sessionPrefix}${scope}`;
  }

  async createSession(scope: string, info: BusSessionInfo): Promise<void> {
    const key = this.sessionKey(scope);
    // hset accepts a flat object in ioredis v5
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(info)) {
      if (v !== undefined && v !== null) flat[k] = String(v);
    }
    await this.pub.hset(key, flat);
    await this.pub.expire(key, this.sessionIdleTimeoutSec);
  }

  async getSession(scope: string): Promise<BusSessionInfo | null> {
    const data = await this.pub.hgetall(this.sessionKey(scope));
    if (!data || !data["scope"]) return null;
    return data as unknown as BusSessionInfo;
  }

  async touchSession(scope: string): Promise<void> {
    const key = this.sessionKey(scope);
    await this.pub.hset(key, "lastActivity", new Date().toISOString());
    await this.pub.expire(key, this.sessionIdleTimeoutSec);
  }

  async updateSession(scope: string, fields: Partial<BusSessionInfo>): Promise<void> {
    const key = this.sessionKey(scope);
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) flat[k] = String(v);
    }
    if (Object.keys(flat).length > 0) {
      await this.pub.hset(key, flat);
    }
  }

  async deleteSession(scope: string): Promise<void> {
    await this.pub.del(this.sessionKey(scope));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    await this.sub.quit().catch(() => {});
    await this.pub.quit().catch(() => {});
  }
}
