/**
 * E2E tests for the Redis event bus — requires a running Redis instance.
 *
 * Tests the full pub/sub round-trip:
 *   OrchestratorBridge.sendAndWait()
 *     → publishes BusUserMessage to stockade:msg:{scope}
 *     → mock worker receives, processes, publishes BusWorkerEvent to stockade:evt:{scope}
 *     → bridge resolves promise with the result text
 *
 * Skip automatically when Redis is not available (no REDIS_URL and
 * localhost:6379 unreachable).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { EventBus } from "../../src/bus/event-bus.js";
import { msgChannel, evtChannel } from "../../src/bus/channels.js";
import type { BusUserMessage, BusWorkerEvent } from "../../src/bus/types.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// ── Helpers ───────────────────────────────────────────────────────────────

async function isRedisAvailable(): Promise<boolean> {
  const r = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 1_000 });
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

/**
 * Minimal mock worker: subscribes to a scope's message channel,
 * immediately publishes a result event back.
 */
function createMockWorker(redisUrl: string) {
  const sub = new Redis(redisUrl);
  const pub = new Redis(redisUrl);

  const subscriptions = new Set<string>();

  async function listenScope(scope: string, reply: (msg: BusUserMessage) => BusWorkerEvent): Promise<void> {
    const ch = msgChannel(scope);
    subscriptions.add(ch);
    await sub.subscribe(ch);

    sub.on("message", (channel: string, data: string) => {
      if (channel !== ch) return;
      try {
        const msg = JSON.parse(data) as BusUserMessage;
        const event = reply(msg);
        pub.publish(evtChannel(scope), JSON.stringify(event));
      } catch { /* ignore parse errors */ }
    });
  }

  async function shutdown(): Promise<void> {
    if (subscriptions.size > 0) {
      await sub.unsubscribe(...subscriptions);
    }
    sub.disconnect();
    pub.disconnect();
  }

  return { listenScope, shutdown };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Redis Event Bus E2E", { timeout: 15_000 }, () => {
  let available = false;
  let bus: EventBus;
  let mockWorker: ReturnType<typeof createMockWorker>;

  beforeAll(async () => {
    available = await isRedisAvailable();
    if (!available) return;

    bus = new EventBus({ redisUrl: REDIS_URL, sessionIdleTimeoutSec: 60 });
    mockWorker = createMockWorker(REDIS_URL);
  });

  afterAll(async () => {
    if (!available) return;
    await mockWorker.shutdown();
    await bus.shutdown();
  });

  it("1. publishes a message and receives the result event via pattern subscription", async () => {
    if (!available) {
      console.log("SKIP: Redis not available");
      return;
    }

    const scope = `test:bus-e2e:${randomUUID()}`;
    const correlationId = randomUUID();

    // Set up mock worker: echo back the text as a result event
    await mockWorker.listenScope(scope, (msg) => ({
      kind: "evt:result",
      correlationId: msg.correlationId,
      scope: msg.scope,
      text: `Echo: ${msg.text}`,
      sdkSessionId: "test-session-1",
      stopReason: "end_turn",
      timestamp: new Date().toISOString(),
    }));

    // Set up listener on the orchestrator side
    const resultPromise = new Promise<BusWorkerEvent>((resolve) => {
      bus.subscribeEvents(scope, (event) => {
        resolve(event);
      });
    });

    bus.startListening();

    // Publish a message
    await bus.publishMessage({
      kind: "user_message",
      correlationId,
      scope,
      text: "Hello from test",
      userId: "test-user",
      userPlatform: "test",
      timestamp: new Date().toISOString(),
    });

    const event = await resultPromise;

    expect(event.kind).toBe("evt:result");
    if (event.kind === "evt:result") {
      expect(event.text).toBe("Echo: Hello from test");
      expect(event.correlationId).toBe(correlationId);
    }
  });

  it("2. multiple concurrent messages on different scopes resolve independently", async () => {
    if (!available) {
      console.log("SKIP: Redis not available");
      return;
    }

    const scope1 = `test:bus-e2e:scope1-${randomUUID()}`;
    const scope2 = `test:bus-e2e:scope2-${randomUUID()}`;

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Worker for scope1: replies after 50ms
    await mockWorker.listenScope(scope1, (msg) => ({
      kind: "evt:result",
      correlationId: msg.correlationId,
      scope: msg.scope,
      text: `scope1: ${msg.text}`,
      sdkSessionId: "s1",
      stopReason: "end_turn",
      timestamp: new Date().toISOString(),
    }));

    // Worker for scope2: replies immediately
    await mockWorker.listenScope(scope2, (msg) => ({
      kind: "evt:result",
      correlationId: msg.correlationId,
      scope: msg.scope,
      text: `scope2: ${msg.text}`,
      sdkSessionId: "s2",
      stopReason: "end_turn",
      timestamp: new Date().toISOString(),
    }));

    const results: BusWorkerEvent[] = [];

    const p1 = new Promise<void>((resolve) => {
      bus.subscribeEvents(scope1, (ev) => { results.push(ev); resolve(); });
    });
    const p2 = new Promise<void>((resolve) => {
      bus.subscribeEvents(scope2, (ev) => { results.push(ev); resolve(); });
    });

    // Publish both concurrently
    await Promise.all([
      bus.publishMessage({
        kind: "user_message",
        correlationId: randomUUID(),
        scope: scope1,
        text: "msg-A",
        userId: "user",
        userPlatform: "test",
        timestamp: new Date().toISOString(),
      }),
      bus.publishMessage({
        kind: "user_message",
        correlationId: randomUUID(),
        scope: scope2,
        text: "msg-B",
        userId: "user",
        userPlatform: "test",
        timestamp: new Date().toISOString(),
      }),
    ]);

    await Promise.all([p1, p2]);

    expect(results.length).toBe(2);
    const texts = results
      .filter((e): e is Extract<BusWorkerEvent, { kind: "evt:result" }> => e.kind === "evt:result")
      .map((e) => e.text);
    expect(texts).toContain("scope1: msg-A");
    expect(texts).toContain("scope2: msg-B");
  });

  it("3. control signal published to agent channel is received by subscriber", async () => {
    if (!available) {
      console.log("SKIP: Redis not available");
      return;
    }

    const agentId = `test-agent-${randomUUID()}`;
    const sub = new Redis(REDIS_URL);
    const ctlChannel = `stockade:ctl:${agentId}`;

    const signalPromise = new Promise<string>((resolve) => {
      sub.subscribe(ctlChannel, () => {
        sub.on("message", (_ch: string, data: string) => {
          resolve(data);
        });
      });
    });

    // Give sub time to subscribe
    await new Promise((r) => setTimeout(r, 100));

    await bus.publishControl(agentId, {
      kind: "control",
      action: "abort",
      scope: "test:scope",
      reason: "test",
      timestamp: new Date().toISOString(),
    });

    const rawSignal = await signalPromise;
    const signal = JSON.parse(rawSignal);

    expect(signal.kind).toBe("control");
    expect(signal.action).toBe("abort");

    sub.disconnect();
  });

  it("4. session state stored and retrieved from Redis hash", async () => {
    if (!available) {
      console.log("SKIP: Redis not available");
      return;
    }

    const scope = `test:session:${randomUUID()}`;

    await bus.createSession(scope, {
      scope,
      agentId: "test-agent",
      callbackToken: "tok-123",
      workerUrl: "http://localhost:3001",
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      state: "active",
    });

    const session = await bus.getSession(scope);
    expect(session).not.toBeNull();
    expect(session?.agentId).toBe("test-agent");
    expect(session?.callbackToken).toBe("tok-123");
    expect(session?.state).toBe("active");

    // Touch updates lastActivity
    const before = session!.lastActivity;
    await new Promise((r) => setTimeout(r, 10));
    await bus.touchSession(scope);
    const updated = await bus.getSession(scope);
    expect(updated?.lastActivity).not.toBe(before);

    // Delete
    await bus.deleteSession(scope);
    const deleted = await bus.getSession(scope);
    expect(deleted).toBeNull();
  });
});
