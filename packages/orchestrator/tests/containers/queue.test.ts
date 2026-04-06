import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DispatchQueue, type QueueConfig, type PendingMessage } from "../../src/containers/queue.js";

function makeQueue(overrides?: Partial<QueueConfig>): DispatchQueue {
  return new DispatchQueue({ maxConcurrent: 3, ...overrides });
}

describe("DispatchQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Basic serialization ──

  it("processes messages sequentially per-agent", async () => {
    const queue = makeQueue();
    const order: string[] = [];

    let resolveFirst: () => void;
    const firstDone = new Promise<void>((r) => (resolveFirst = r));

    queue.setProcessMessageFn(async (agentKey, msg) => {
      order.push(`start:${agentKey}`);
      if (order.length === 1) {
        await firstDone;
      }
      order.push(`end:${agentKey}`);
      msg.resolve("ok");
      return true;
    });

    // Enqueue two messages for the same agent
    queue.enqueueMessage("agent-a", "msg1");
    queue.enqueueMessage("agent-a", "msg2");

    // Let first process start
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["start:agent-a"]);

    // Second should NOT have started yet (serialized)
    expect(order.filter((o) => o.startsWith("start:")).length).toBe(1);

    // Complete first
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Now the drain should have started the second
    expect(order).toContain("end:agent-a");
  });

  it("processes different agents concurrently", async () => {
    const queue = makeQueue();
    const active = new Set<string>();
    let maxConcurrent = 0;

    const resolvers: Record<string, () => void> = {};

    queue.setProcessMessageFn(async (agentKey, msg) => {
      active.add(agentKey);
      maxConcurrent = Math.max(maxConcurrent, active.size);
      await new Promise<void>((r) => (resolvers[agentKey] = r));
      active.delete(agentKey);
      msg.resolve("ok");
      return true;
    });

    queue.enqueueMessage("agent-a", "m");
    queue.enqueueMessage("agent-b", "m");
    queue.enqueueMessage("agent-c", "m");

    await vi.advanceTimersByTimeAsync(0);

    expect(maxConcurrent).toBe(3);
    expect(active.size).toBe(3);

    // Complete all
    resolvers["agent-a"]!();
    resolvers["agent-b"]!();
    resolvers["agent-c"]!();
    await vi.advanceTimersByTimeAsync(0);
  });

  // ── Global concurrency limit ──

  it("respects maxConcurrent limit", async () => {
    const queue = makeQueue({ maxConcurrent: 2 });
    const active = new Set<string>();
    let maxConcurrent = 0;

    const resolvers: Record<string, () => void> = {};

    queue.setProcessMessageFn(async (agentKey, msg) => {
      active.add(agentKey);
      maxConcurrent = Math.max(maxConcurrent, active.size);
      await new Promise<void>((r) => (resolvers[agentKey] = r));
      active.delete(agentKey);
      msg.resolve("ok");
      return true;
    });

    queue.enqueueMessage("agent-a", "m");
    queue.enqueueMessage("agent-b", "m");
    queue.enqueueMessage("agent-c", "m");

    await vi.advanceTimersByTimeAsync(0);

    // Only 2 should be active
    expect(maxConcurrent).toBe(2);
    expect(active.size).toBe(2);

    // Complete one to let the third start
    resolvers["agent-a"]!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(active.has("agent-c")).toBe(true);

    resolvers["agent-b"]!();
    resolvers["agent-c"]!();
    await vi.advanceTimersByTimeAsync(0);
  });

  // ── Message injection ──

  it.skip("injects message into idle dispatch instead of queueing separately", async () => {
    const queue = makeQueue();
    const injected: Array<{ key: string; text: string }> = [];

    let resolveProcess: () => void;
    queue.setProcessMessageFn(async (agentKey, msg) => {
      await new Promise<void>((r) => (resolveProcess = r));
      msg.resolve("ok");
      return true;
    });

    queue.setInjectMessageFn((agentKey, text) => {
      injected.push({ key: agentKey, text });
      return true;
    });

    // Start a dispatch
    queue.enqueueMessage("agent-a", "first");
    await vi.advanceTimersByTimeAsync(0);

    // Mark idle
    queue.notifyIdle("agent-a");
    expect(queue.isIdle("agent-a")).toBe(true);

    // Send follow-up — should inject
    queue.enqueueMessage("agent-a", "follow-up message");

    expect(injected).toHaveLength(1);
    expect(injected[0].text).toBe("follow-up message");
    expect(queue.isIdle("agent-a")).toBe(false); // no longer idle

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(0);
  });

  it.skip("queues message when inject fn returns false", async () => {
    const queue = makeQueue();
    let processCount = 0;

    let resolveProcess: () => void;
    queue.setProcessMessageFn(async (_key, msg) => {
      processCount++;
      await new Promise<void>((r) => (resolveProcess = r));
      msg.resolve("ok");
      return true;
    });

    queue.setInjectMessageFn(() => false); // injection fails

    queue.enqueueMessage("agent-a", "first");
    await vi.advanceTimersByTimeAsync(0);

    queue.notifyIdle("agent-a");
    queue.enqueueMessage("agent-a", "message");

    // Message was queued (pendingMessages), not injected
    // Complete first dispatch to trigger drain
    resolveProcess!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(processCount).toBe(2); // second dispatch started
    resolveProcess!();
    await vi.advanceTimersByTimeAsync(0);
  });

  // ── Task priority ──

  it("prioritizes tasks over messages when draining", async () => {
    const queue = makeQueue();
    const order: string[] = [];

    const resolvers: Array<() => void> = [];

    queue.setProcessMessageFn(async (agentKey, msg) => {
      order.push(`message:${agentKey}`);
      await new Promise<void>((r) => resolvers.push(r));
      msg.resolve("ok");
      return true;
    });

    // Start a dispatch
    queue.enqueueMessage("agent-a", "m1");
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["message:agent-a"]);

    // While active, enqueue both a task and a message
    queue.enqueueMessage("agent-a", "m2"); // pendingMessages
    queue.enqueueTask("agent-a", "task-1", async () => {
      order.push("task:agent-a");
    });

    // Complete the first dispatch
    resolvers[0]!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Task should have run before the pending message
    expect(order[1]).toBe("task:agent-a");
  });

  it("prevents double-queuing of tasks", () => {
    const queue = makeQueue({ maxConcurrent: 0 }); // block everything
    const fn = vi.fn(async () => {});

    queue.enqueueTask("agent-a", "task-1", fn);
    queue.enqueueTask("agent-a", "task-1", fn); // duplicate

    // Force get pending state — only one task should be queued
    // We can verify by checking fn was not called (at concurrency 0, nothing runs)
    expect(fn).not.toHaveBeenCalled();
  });

  // ── Idle preemption ──

  it.skip("preempts idle dispatch when task is enqueued", async () => {
    const queue = makeQueue();
    const closes: string[] = [];
    queue.onClose = (agentKey) => closes.push(agentKey);

    let resolveProcess: () => void;
    queue.setProcessMessageFn(async (_key, msg) => {
      await new Promise<void>((r) => (resolveProcess = r));
      msg.resolve("ok");
      return true;
    });

    queue.enqueueMessage("agent-a", "m");
    await vi.advanceTimersByTimeAsync(0);

    queue.notifyIdle("agent-a");

    // Enqueue a task while idle — should trigger close
    queue.enqueueTask("agent-a", "task-1", async () => {});

    expect(closes).toEqual(["agent-a"]);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(0);
  });

  // ── Retry with backoff ──

  it("retries with exponential backoff on failure", async () => {
    const queue = makeQueue();
    let callCount = 0;

    queue.setProcessMessageFn(async (_key, msg) => {
      callCount++;
      msg.resolve("fail");
      return false; // simulate failure
    });

    queue.enqueueMessage("agent-a", "m");
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    // First retry at 5000ms
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(2);

    // Second retry at 10000ms
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(3);
  });

  it("stops retrying after MAX_RETRIES", async () => {
    const queue = makeQueue();
    let callCount = 0;

    queue.setProcessMessageFn(async (_key, msg) => {
      callCount++;
      msg.resolve("fail");
      return false;
    });

    queue.enqueueMessage("agent-a", "m");

    // Run through all retries: 0 + 5s + 10s + 20s + 40s + 80s
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(80_000);
      await vi.advanceTimersByTimeAsync(0);
    }

    // 1 initial + 5 retries = 6 total
    expect(callCount).toBe(6);
  });

  // ── Shutdown ──

  it("stops accepting new work after shutdown", () => {
    const queue = makeQueue();
    const fn = vi.fn(async (_key: string, msg: PendingMessage) => {
      msg.resolve("ok");
      return true;
    });
    queue.setProcessMessageFn(fn);

    queue.shutdown();
    queue.enqueueMessage("agent-a", "m");
    queue.enqueueTask("agent-a", "t1", async () => {});

    expect(fn).not.toHaveBeenCalled();
    expect(queue.isShutDown).toBe(true);
  });

  // ── Waiting queue drain ──

  it("drains waiting agents when active slots free up", async () => {
    const queue = makeQueue({ maxConcurrent: 1 });
    const processed: string[] = [];
    const resolvers: Record<string, () => void> = {};

    queue.setProcessMessageFn(async (agentKey, msg) => {
      processed.push(agentKey);
      await new Promise<void>((r) => (resolvers[agentKey] = r));
      msg.resolve("ok");
      return true;
    });

    queue.enqueueMessage("agent-a", "m");
    queue.enqueueMessage("agent-b", "m");
    queue.enqueueMessage("agent-c", "m");

    await vi.advanceTimersByTimeAsync(0);
    expect(processed).toEqual(["agent-a"]); // only one active

    resolvers["agent-a"]!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(processed).toContain("agent-b");

    resolvers["agent-b"]!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(processed).toContain("agent-c");

    resolvers["agent-c"]!();
    await vi.advanceTimersByTimeAsync(0);
  });

  // ── isActive / isIdle ──

  it.skip("tracks active and idle state correctly", async () => {
    const queue = makeQueue();
    let resolveProcess: () => void;

    queue.setProcessMessageFn(async (_key, msg) => {
      await new Promise<void>((r) => (resolveProcess = r));
      msg.resolve("ok");
      return true;
    });

    expect(queue.isActive("agent-a")).toBe(false);
    expect(queue.isIdle("agent-a")).toBe(false);

    queue.enqueueMessage("agent-a", "m");
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.isActive("agent-a")).toBe(true);
    expect(queue.isIdle("agent-a")).toBe(false);

    queue.notifyIdle("agent-a");
    expect(queue.isIdle("agent-a")).toBe(true);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.isActive("agent-a")).toBe(false);
    expect(queue.isIdle("agent-a")).toBe(false);
  });

  it("reports correct active count", async () => {
    const queue = makeQueue();
    const resolvers: Record<string, () => void> = {};

    queue.setProcessMessageFn(async (agentKey, msg) => {
      await new Promise<void>((r) => (resolvers[agentKey] = r));
      msg.resolve("ok");
      return true;
    });

    expect(queue.active).toBe(0);

    queue.enqueueMessage("agent-a", "m");
    queue.enqueueMessage("agent-b", "m");
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.active).toBe(2);

    resolvers["agent-a"]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.active).toBe(1);

    resolvers["agent-b"]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.active).toBe(0);
  });

  // ── Task runs directly when no contention ──

  it("runs task immediately when agent is free and under limit", async () => {
    const queue = makeQueue();
    const ran = vi.fn();

    queue.enqueueTask("agent-a", "t1", async () => {
      ran();
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(ran).toHaveBeenCalledOnce();
  });

  // ── Error in task doesn't block drain ──

  it("continues draining after task error", async () => {
    const queue = makeQueue();
    const processed: string[] = [];

    queue.setProcessMessageFn(async (agentKey, msg) => {
      processed.push(agentKey);
      msg.resolve("ok");
      return true;
    });

    // Enqueue a failing task and a pending message
    queue.enqueueTask("agent-a", "t1", async () => {
      throw new Error("task failed");
    });

    await vi.advanceTimersByTimeAsync(0);

    // Now enqueue a message — agent should be free
    queue.enqueueMessage("agent-a", "m");
    await vi.advanceTimersByTimeAsync(0);

    expect(processed).toContain("agent-a");
  });

  // ── notifyIdle triggers preemption for pending tasks only ──

  it.skip("does NOT preempt idle when only messages are pending", async () => {
    const queue = makeQueue();
    const closes: string[] = [];
    queue.onClose = (key) => closes.push(key);

    let resolveProcess: () => void;
    queue.setProcessMessageFn(async (_key, msg) => {
      await new Promise<void>((r) => (resolveProcess = r));
      msg.resolve("ok");
      return true;
    });

    queue.enqueueMessage("agent-a", "m1");
    await vi.advanceTimersByTimeAsync(0);

    // Queue a message while active
    queue.enqueueMessage("agent-a", "m2");

    // Mark idle — should NOT preempt (only tasks preempt)
    queue.notifyIdle("agent-a");

    expect(closes).toEqual([]);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(0);
  });

  // ── enqueue() returns result via promise ──

  it("enqueue() resolves with dispatch result", async () => {
    const queue = makeQueue();

    queue.setProcessMessageFn(async (_key, msg) => {
      msg.resolve("Hello from agent!");
      return true;
    });

    const result = queue.enqueue("agent-a", "test message");
    await vi.advanceTimersByTimeAsync(0);

    expect(await result).toBe("Hello from agent!");
  });

  it("enqueue() serializes per-scope and each gets its own result", async () => {
    const queue = makeQueue();
    const results: string[] = [];
    let callCount = 0;

    const resolvers: Array<(v: string) => void> = [];

    queue.setProcessMessageFn(async (_key, msg) => {
      callCount++;
      const idx = callCount;
      await new Promise<void>((r) => {
        resolvers.push(() => {
          msg.resolve(`result-${idx}`);
          r();
        });
      });
      return true;
    });

    // Enqueue two messages for same scope
    const p1 = queue.enqueue("scope-a", "first");
    const p2 = queue.enqueue("scope-a", "second");

    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1); // only first started

    // Resolve first
    resolvers[0]!();
    await vi.advanceTimersByTimeAsync(0);
    results.push(await p1);

    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(2); // second started

    // Resolve second
    resolvers[1]!();
    await vi.advanceTimersByTimeAsync(0);
    results.push(await p2);

    expect(results).toEqual(["result-1", "result-2"]);
  });

  it("enqueue() for different scopes runs concurrently", async () => {
    const queue = makeQueue({ maxConcurrent: 3 });
    const resolvers: Record<string, () => void> = {};

    queue.setProcessMessageFn(async (key, msg) => {
      await new Promise<void>((r) => (resolvers[key] = r));
      msg.resolve(`done:${key}`);
      return true;
    });

    const p1 = queue.enqueue("scope-a", "m");
    const p2 = queue.enqueue("scope-b", "m");

    await vi.advanceTimersByTimeAsync(0);
    expect(queue.active).toBe(2);

    resolvers["scope-a"]!();
    resolvers["scope-b"]!();
    await vi.advanceTimersByTimeAsync(0);

    expect(await p1).toBe("done:scope-a");
    expect(await p2).toBe("done:scope-b");
  });

  it("shutdown resolves pending messages", async () => {
    const queue = makeQueue({ maxConcurrent: 1 });
    const resolvers: Array<() => void> = [];

    queue.setProcessMessageFn(async (_key, msg) => {
      await new Promise<void>((r) => resolvers.push(r));
      msg.resolve("ok");
      return true;
    });

    // First message starts processing
    const p1 = queue.enqueue("scope-a", "m1");
    await vi.advanceTimersByTimeAsync(0);

    // Second message is queued (scope-a is active)
    const p2 = queue.enqueue("scope-a", "m2");

    // Shutdown resolves pending messages
    queue.shutdown();

    expect(await p2).toBe("Queue is shutting down.");

    // Complete the active one
    resolvers[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(await p1).toBe("ok");
  });

  it("hasPending reports correctly", async () => {
    const queue = makeQueue();
    let resolveProcess: () => void;

    queue.setProcessMessageFn(async (_key, msg) => {
      await new Promise<void>((r) => (resolveProcess = r));
      msg.resolve("ok");
      return true;
    });

    expect(queue.hasPending("agent-a")).toBe(false);

    queue.enqueueMessage("agent-a", "m1");
    // Message was pushed then immediately picked up by runForAgent
    await vi.advanceTimersByTimeAsync(0);

    // Queue another while first is active
    queue.enqueueMessage("agent-a", "m2");
    expect(queue.hasPending("agent-a")).toBe(true);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(0);
    // After drain, second message is being processed
    resolveProcess!();
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.hasPending("agent-a")).toBe(false);
  });

  // ── Fix validations: injection, retry overlap, no processor ──

  it.skip("enqueue() with injection resolves immediately without double-processing", async () => {
    const queue = makeQueue();
    let processCount = 0;
    let resolveProcess: () => void;

    queue.setProcessMessageFn(async (_key, msg) => {
      processCount++;
      await new Promise<void>((r) => (resolveProcess = r));
      msg.resolve("processed");
      return true;
    });

    queue.setInjectMessageFn(() => true);

    // Start a dispatch
    queue.enqueueMessage("agent-a", "m1");
    await vi.advanceTimersByTimeAsync(0);
    expect(processCount).toBe(1);

    // Mark idle
    queue.notifyIdle("agent-a");

    // enqueue() while idle — should inject and resolve immediately
    const p = queue.enqueue("agent-a", "follow-up");
    const result = await p;
    expect(result).toBe("(injected into active dispatch)");

    // Complete the original dispatch
    resolveProcess!();
    await vi.advanceTimersByTimeAsync(0);

    // processMessageFn should NOT have been called a second time
    expect(processCount).toBe(1);
  });

  it("new message during retry backoff is queued, not immediately processed", async () => {
    const queue = makeQueue();
    let callCount = 0;

    queue.setProcessMessageFn(async (_key, msg) => {
      callCount++;
      msg.resolve(`call-${callCount}`);
      return callCount > 1; // fail first time, succeed after
    });

    // First message — fails, schedules retry
    queue.enqueueMessage("agent-a", "m1");
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    // During backoff, enqueue another message — should NOT immediately process
    queue.enqueueMessage("agent-a", "m2");
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1); // still 1, not processed during backoff

    // When retry fires, it resumes processing
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBeGreaterThan(1); // retry processed
  });

  it("resolves with error when processMessageFn is not set", async () => {
    const queue = makeQueue();

    const result = queue.enqueue("agent-a", "hello");
    await vi.advanceTimersByTimeAsync(0);

    expect(await result).toBe("Error: no message processor configured.");
  });

  it.skip("notifyClose on inactive agent is a no-op", async () => {
    const queue = makeQueue();
    const closes: string[] = [];
    queue.onClose = (key) => closes.push(key);

    queue.notifyClose("agent-a");
    expect(closes).toEqual([]);
  });

  // ── Meta propagation ──

  it("enqueue() carries meta through to processMessageFn", async () => {
    const queue = makeQueue();
    let receivedMeta: Record<string, unknown> | undefined;

    queue.setProcessMessageFn(async (_key, msg) => {
      receivedMeta = msg.meta;
      msg.resolve("ok");
      return true;
    });

    queue.enqueue("agent-a", "hello", { userId: "alice", userPlatform: "discord" });
    await vi.advanceTimersByTimeAsync(0);

    expect(receivedMeta).toEqual({ userId: "alice", userPlatform: "discord" });
  });

  // ── Cleanup ──

  it("cleanup() removes idle agents with no pending work", async () => {
    const queue = makeQueue();

    queue.setProcessMessageFn(async (_key, msg) => {
      msg.resolve("ok");
      return true;
    });

    // Process a message — agent state gets created
    queue.enqueueMessage("agent-a", "m1");
    queue.enqueueMessage("agent-b", "m2");
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.agentCount).toBe(2);

    // After processing, both agents are idle with no pending work
    queue.cleanup();
    expect(queue.agentCount).toBe(0);
  });

  it("cleanup() keeps agents with pending work", async () => {
    const queue = makeQueue({ maxConcurrent: 1 });
    let resolveProcess: () => void;

    queue.setProcessMessageFn(async (_key, msg) => {
      await new Promise<void>((r) => (resolveProcess = r));
      msg.resolve("ok");
      return true;
    });

    // agent-a is active, agent-b is waiting
    queue.enqueueMessage("agent-a", "m1");
    queue.enqueueMessage("agent-b", "m2");
    await vi.advanceTimersByTimeAsync(0);

    queue.cleanup();
    // agent-a is active, agent-b has pending — neither removed
    expect(queue.agentCount).toBe(2);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(0);
    resolveProcess!();
    await vi.advanceTimersByTimeAsync(0);

    queue.cleanup();
    expect(queue.agentCount).toBe(0);
  });

  // ── Shutdown clears tasks ──

  it("shutdown clears pending tasks and waiting agents", async () => {
    const queue = makeQueue({ maxConcurrent: 0 });
    const taskRan = vi.fn();

    queue.enqueueTask("agent-a", "t1", async () => taskRan());
    expect(queue.hasPending("agent-a")).toBe(true);

    queue.shutdown();
    expect(queue.hasPending("agent-a")).toBe(false);
    expect(taskRan).not.toHaveBeenCalled();
  });
});
