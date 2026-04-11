/**
 * E2E tests for the Redis event bus — real Redis, zero mocks.
 *
 * Tests the full pub/sub round-trip that underlies the Redis dispatch
 * architecture: orchestrator publishes messages, workers receive them,
 * workers publish result events, orchestrator routes them back.
 *
 * Also tests:
 *   - ConcurrencyGate (pure in-memory, no Redis)
 *   - Coalesce logic: multiple pending promises for the same scope
 *     all resolve when the first result arrives
 *   - Session state in Redis hashes (CRUD + TTL touch)
 *   - Pattern subscription (subscribeAllEvents across multiple scopes)
 *
 * Redis requirement: tests auto-skip when Redis is not reachable.
 * Start Redis with: docker run -p 6379:6379 redis:alpine
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { EventBus } from "../../src/bus/event-bus.js";
import { ConcurrencyGate } from "../../src/bus/concurrency-gate.js";
import { msgChannel, evtChannel } from "../../src/bus/channels.js";
import type {
  BusUserMessage,
  BusWorkerEvent,
  BusEventResult,
} from "../../src/bus/types.js";

// ── Redis availability check ──────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

async function isRedisAvailable(): Promise<boolean> {
  try {
    const bus = new EventBus({ redisUrl: REDIS_URL });
    // publishMessage exercises the pub connection
    await bus.publishEvent("_probe", {
      kind: "evt:result",
      scope: "_probe",
      correlationId: "probe",
      text: "ping",
      sdkSessionId: "probe",
      stopReason: "end_turn",
      timestamp: new Date().toISOString(),
    });
    await bus.shutdown();
    return true;
  } catch {
    return false;
  }
}

// ── Test utilities ────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

/** Make a BusUserMessage with defaults. */
function makeMsg(overrides: Partial<BusUserMessage> = {}): BusUserMessage {
  return {
    kind: "user_message",
    correlationId: randomUUID(),
    scope: `test:${randomUUID()}`,
    text: "hello",
    userId: "test-user",
    userPlatform: "test",
    timestamp: ts(),
    ...overrides,
  };
}

/** Make a BusEventResult with defaults. */
function makeResult(overrides: Partial<BusEventResult> = {}): BusEventResult {
  return {
    kind: "evt:result",
    scope: `test:${randomUUID()}`,
    correlationId: randomUUID(),
    text: "done",
    sdkSessionId: `sdk-${randomUUID().slice(0, 8)}`,
    stopReason: "end_turn",
    timestamp: ts(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ConcurrencyGate — pure in-memory, no Redis needed
// ═══════════════════════════════════════════════════════════════════════════

describe("ConcurrencyGate", { timeout: 5_000 }, () => {
  it("1. allows concurrent scopes up to the limit", async () => {
    const gate = new ConcurrencyGate(3);

    await gate.acquire("scope-a");
    await gate.acquire("scope-b");
    await gate.acquire("scope-c");

    expect(gate.activeCount).toBe(3);
    expect(gate.isActive("scope-a")).toBe(true);
    expect(gate.isActive("scope-b")).toBe(true);
    expect(gate.isActive("scope-c")).toBe(true);

    gate.release("scope-a");
    gate.release("scope-b");
    gate.release("scope-c");
    expect(gate.activeCount).toBe(0);
  });

  it("2. blocks at limit and unblocks when a slot is released", async () => {
    const gate = new ConcurrencyGate(2);

    await gate.acquire("scope-a");
    await gate.acquire("scope-b");
    expect(gate.activeCount).toBe(2);

    // scope-c should block
    let unblocked = false;
    const waiting = gate.acquire("scope-c").then(() => { unblocked = true; });

    // Not unblocked yet
    await new Promise((r) => setTimeout(r, 10));
    expect(unblocked).toBe(false);

    // Release one slot
    gate.release("scope-a");

    // scope-c should unblock
    await waiting;
    expect(unblocked).toBe(true);
    expect(gate.isActive("scope-c")).toBe(true);
    expect(gate.activeCount).toBe(2); // b + c

    gate.release("scope-b");
    gate.release("scope-c");
  });

  it("3. re-entrant: same scope acquiring again resolves immediately", async () => {
    const gate = new ConcurrencyGate(1);

    await gate.acquire("scope-x");
    expect(gate.activeCount).toBe(1);

    // Acquiring same scope again should resolve immediately (not block)
    const start = Date.now();
    await gate.acquire("scope-x");
    expect(Date.now() - start).toBeLessThan(10);
    expect(gate.activeCount).toBe(1); // still 1 — not double-counted

    gate.release("scope-x");
    expect(gate.activeCount).toBe(0);
  });

  it("4. multiple waiters drain in order", async () => {
    const gate = new ConcurrencyGate(1);
    await gate.acquire("first");

    const order: string[] = [];
    const p1 = gate.acquire("second").then(() => { order.push("second"); });
    const p2 = gate.acquire("third").then(() => { order.push("third"); });

    // Both waiting
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);

    gate.release("first");
    await p1;
    expect(order).toEqual(["second"]);

    gate.release("second");
    await p2;
    expect(order).toEqual(["second", "third"]);

    gate.release("third");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EventBus — requires live Redis
// ═══════════════════════════════════════════════════════════════════════════

describe("EventBus — Redis pub/sub", { timeout: 15_000 }, () => {
  let redisAvailable = false;

  beforeAll(async () => {
    redisAvailable = await isRedisAvailable();
    if (!redisAvailable) {
      console.log("[skip] Redis not available — skipping EventBus tests");
    }
  });

  it("5. publish + subscribe round-trip for a single scope", async () => {
    if (!redisAvailable) return;

    const scope = `test:${randomUUID()}`;
    const pub = new EventBus({ redisUrl: REDIS_URL });
    const sub = new EventBus({ redisUrl: REDIS_URL });

    const received: BusWorkerEvent[] = [];
    await sub.subscribeEvents(scope, (evt) => received.push(evt));
    sub.startListening();

    // Give the subscription a moment to register with Redis
    await new Promise((r) => setTimeout(r, 50));

    const result = makeResult({ scope, correlationId: "cid-123" });
    await pub.publishEvent(scope, result);

    // Wait for delivery
    await new Promise((r) => setTimeout(r, 100));

    expect(received.length).toBe(1);
    expect(received[0].kind).toBe("evt:result");
    expect((received[0] as BusEventResult).text).toBe("done");
    expect((received[0] as BusEventResult).correlationId).toBe("cid-123");

    await pub.shutdown();
    await sub.shutdown();
  });

  it("6. pattern subscription (subscribeAllEvents) receives events from multiple scopes", async () => {
    if (!redisAvailable) return;

    const scopeA = `test-a:${randomUUID()}`;
    const scopeB = `test-b:${randomUUID()}`;

    const pub = new EventBus({ redisUrl: REDIS_URL });
    const sub = new EventBus({ redisUrl: REDIS_URL });

    const received: Array<{ scope: string; event: BusWorkerEvent }> = [];
    await sub.subscribeAllEvents((s, e) => received.push({ scope: s, event: e }));
    sub.startListening();

    await new Promise((r) => setTimeout(r, 50));

    await pub.publishEvent(scopeA, makeResult({ scope: scopeA, text: "result-a" }));
    await pub.publishEvent(scopeB, makeResult({ scope: scopeB, text: "result-b" }));

    await new Promise((r) => setTimeout(r, 150));

    const a = received.find((r) => r.scope === scopeA);
    const b = received.find((r) => r.scope === scopeB);

    expect(a).toBeDefined();
    expect((a!.event as BusEventResult).text).toBe("result-a");
    expect(b).toBeDefined();
    expect((b!.event as BusEventResult).text).toBe("result-b");

    await pub.shutdown();
    await sub.shutdown();
  });

  it("7. full message + event round-trip simulating worker dispatch", async () => {
    if (!redisAvailable) return;

    // This is the core test: simulates the full dispatch path.
    //
    // Orchestrator side: subscribes to evt channel, publishes msg
    // Worker side:       subscribes to msg channel, receives it, publishes result
    //
    // The same Redis round-trip happens in production for every agent turn.

    const scope = `test:${randomUUID()}`;
    const correlationId = randomUUID();

    const orchestrator = new EventBus({ redisUrl: REDIS_URL });
    const worker = new EventBus({ redisUrl: REDIS_URL });

    // Orchestrator subscribes to events for this scope
    const resultPromise = new Promise<BusEventResult>((resolve) => {
      orchestrator.subscribeEvents(scope, (evt) => {
        if (evt.kind === "evt:result") resolve(evt as BusEventResult);
      });
    });
    orchestrator.startListening();

    // Worker subscribes to messages for this scope
    const msgPromise = new Promise<BusUserMessage>((resolve) => {
      worker["sub"].subscribe(msgChannel(scope));
      worker["sub"].on("message", (_ch: string, data: string) => {
        const msg = JSON.parse(data) as BusUserMessage;
        if (msg.kind === "user_message") resolve(msg);
      });
    });

    await new Promise((r) => setTimeout(r, 50));

    // Orchestrator publishes the user message
    const userMsg: BusUserMessage = {
      kind: "user_message",
      correlationId,
      scope,
      text: "What is 2+2?",
      userId: "test-user",
      userPlatform: "test",
      timestamp: ts(),
    };
    await orchestrator.publishMessage(userMsg);

    // Worker receives the message
    const receivedMsg = await msgPromise;
    expect(receivedMsg.text).toBe("What is 2+2?");
    expect(receivedMsg.correlationId).toBe(correlationId);

    // Worker publishes the result event
    await worker.publishEvent(scope, {
      kind: "evt:result",
      scope,
      correlationId: receivedMsg.correlationId,
      text: "4",
      sdkSessionId: "sdk-test-001",
      stopReason: "end_turn",
      timestamp: ts(),
    });

    // Orchestrator receives the result
    const result = await resultPromise;
    expect(result.text).toBe("4");
    expect(result.correlationId).toBe(correlationId);
    expect(result.sdkSessionId).toBe("sdk-test-001");

    await orchestrator.shutdown();
    await worker.shutdown();
  });

  it("8. session state CRUD — createSession/getSession/touchSession/deleteSession", async () => {
    if (!redisAvailable) return;

    const scope = `test:${randomUUID()}`;
    const bus = new EventBus({ redisUrl: REDIS_URL, sessionIdleTimeoutSec: 10 });

    await bus.createSession(scope, {
      scope,
      agentId: "main",
      callbackToken: "tok-abc",
      workerUrl: "http://localhost:3001",
      createdAt: ts(),
      lastActivity: ts(),
      state: "active",
    });

    const session = await bus.getSession(scope);
    expect(session).not.toBeNull();
    expect(session!.scope).toBe(scope);
    expect(session!.agentId).toBe("main");
    expect(session!.callbackToken).toBe("tok-abc");
    expect(session!.state).toBe("active");

    // Touch updates lastActivity
    await bus.touchSession(scope);
    const touched = await bus.getSession(scope);
    expect(touched).not.toBeNull();

    // Update a field
    await bus.updateSession(scope, { state: "idle", sdkSessionId: "sdk-xyz" });
    const updated = await bus.getSession(scope);
    expect(updated!.state).toBe("idle");
    expect(updated!.sdkSessionId).toBe("sdk-xyz");

    // Delete
    await bus.deleteSession(scope);
    const deleted = await bus.getSession(scope);
    expect(deleted).toBeNull();

    await bus.shutdown();
  });

  it("9. unsubscribeEvents stops delivery", async () => {
    if (!redisAvailable) return;

    const scope = `test:${randomUUID()}`;
    const pub = new EventBus({ redisUrl: REDIS_URL });
    const sub = new EventBus({ redisUrl: REDIS_URL });

    const received: BusWorkerEvent[] = [];
    await sub.subscribeEvents(scope, (evt) => received.push(evt));
    sub.startListening();

    await new Promise((r) => setTimeout(r, 50));

    // Publish one — should be received
    await pub.publishEvent(scope, makeResult({ scope }));
    await new Promise((r) => setTimeout(r, 100));
    expect(received.length).toBe(1);

    // Unsubscribe, then publish another — should not arrive
    await sub.unsubscribeEvents(scope);
    await new Promise((r) => setTimeout(r, 50));

    await pub.publishEvent(scope, makeResult({ scope }));
    await new Promise((r) => setTimeout(r, 100));
    expect(received.length).toBe(1); // unchanged

    await pub.shutdown();
    await sub.shutdown();
  });

  it("10. concurrent messages to different scopes are delivered independently", async () => {
    if (!redisAvailable) return;

    const N = 5;
    const scopes = Array.from({ length: N }, () => `test:${randomUUID()}`);

    const pub = new EventBus({ redisUrl: REDIS_URL });
    const sub = new EventBus({ redisUrl: REDIS_URL });

    // Subscribe to all scopes
    const received = new Map<string, BusEventResult>();
    for (const scope of scopes) {
      await sub.subscribeEvents(scope, (evt) => {
        if (evt.kind === "evt:result") {
          received.set(scope, evt as BusEventResult);
        }
      });
    }
    sub.startListening();

    await new Promise((r) => setTimeout(r, 50));

    // Publish a unique result to each scope concurrently
    await Promise.all(
      scopes.map((scope) =>
        pub.publishEvent(scope, makeResult({ scope, text: `result-for-${scope}` }))
      )
    );

    // Wait for all to arrive
    await new Promise((r) => setTimeout(r, 200));

    for (const scope of scopes) {
      const r = received.get(scope);
      expect(r, `expected result for ${scope}`).toBeDefined();
      expect(r!.text).toBe(`result-for-${scope}`);
    }

    await pub.shutdown();
    await sub.shutdown();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bridge coalesce logic — pure unit test (no Redis needed)
// ═══════════════════════════════════════════════════════════════════════════

describe("Bridge coalesce logic — injected message resolution", { timeout: 5_000 }, () => {
  /**
   * The bridge holds a Map<correlationId, Pending> where each entry has
   * { resolve, scope, ... }. When a result arrives for correlationId A,
   * all OTHER pending entries for the same scope are also resolved
   * (they were mid-turn injections that the agent addressed in one reply).
   *
   * We test this logic directly without needing the full bridge machinery.
   */

  it("11. coalesce: result for scope resolves all pending promises for that scope", () => {
    const scope = "discord:test-guild:test-channel";

    interface Pending {
      resolve: (text: string) => void;
      scope: string;
    }

    const pending = new Map<string, Pending>();

    // Simulate three messages sent to the same scope
    const results: string[] = [];
    const makePromise = (cid: string) =>
      new Promise<string>((resolve) => {
        pending.set(cid, { resolve, scope });
      }).then((text) => { results.push(text); return text; });

    const p1 = makePromise("cid-1"); // the first — sends the query
    const p2 = makePromise("cid-2"); // injected mid-turn
    const p3 = makePromise("cid-3"); // injected mid-turn

    // Simulate result arriving for the query that started the turn (cid-1)
    const resultCorrelationId = "cid-1";
    const resultText = "All three questions answered.";

    // Coalesce: resolve all other pending for same scope
    for (const [cid, op] of pending) {
      if (op.scope === scope && cid !== resultCorrelationId) {
        pending.delete(cid);
        op.resolve(resultText);
      }
    }
    // Then resolve the primary
    const primary = pending.get(resultCorrelationId)!;
    pending.delete(resultCorrelationId);
    primary.resolve(resultText);

    return Promise.all([p1, p2, p3]).then(() => {
      // All three promises should resolve to the same text
      expect(results).toHaveLength(3);
      expect(results.every((r) => r === resultText)).toBe(true);
      expect(pending.size).toBe(0);
    });
  });

  it("12. coalesce: pending for a different scope is not resolved", () => {
    const scopeA = "discord:guild:channel-a";
    const scopeB = "discord:guild:channel-b";

    interface Pending {
      resolve: (text: string) => void;
      scope: string;
    }

    const pending = new Map<string, Pending>();

    const resolvedA = { value: "" };
    const resolvedB = { value: "" };

    pending.set("cid-a", { resolve: (t) => { resolvedA.value = t; }, scope: scopeA });
    pending.set("cid-b", { resolve: (t) => { resolvedB.value = t; }, scope: scopeB });

    // Result arrives for scope A (cid-a)
    for (const [cid, op] of pending) {
      if (op.scope === scopeA && cid !== "cid-a") {
        pending.delete(cid);
        op.resolve("result-a");
      }
    }
    const primaryA = pending.get("cid-a")!;
    pending.delete("cid-a");
    primaryA.resolve("result-a");

    // scope A resolved; scope B still pending
    expect(resolvedA.value).toBe("result-a");
    expect(resolvedB.value).toBe(""); // untouched
    expect(pending.size).toBe(1);
    expect(pending.has("cid-b")).toBe(true);
  });
});
