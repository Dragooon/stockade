/**
 * E2E tests for DispatchQueue — real async operations, real concurrency, real timing.
 *
 * These tests exercise the queue as a real user would experience it:
 * - Actual promise-based async operations
 * - Real concurrency with multiple agents
 * - Fake timers for backoff/scheduling tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DispatchQueue,
  type QueueConfig,
} from "../../src/containers/queue.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeQueue(overrides?: Partial<QueueConfig>): DispatchQueue {
  return new DispatchQueue({ maxConcurrent: 5, ...overrides });
}

/** Returns a promise and its resolver together. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Flush all pending microtasks / already-resolved promises. */
async function flush(): Promise<void> {
  // Multiple awaits drain nested promise chains
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ── Serialization ─────────────────────────────────────────────────────────────

describe("Serialization — positive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("test 1: two messages for same agent processed sequentially (second waits for first)", async () => {
    const queue = makeQueue();
    const order: string[] = [];

    const first = deferred();
    let callCount = 0;

    queue.setProcessMessageFn(async (agentKey) => {
      callCount++;
      const idx = callCount;
      order.push(`start:${agentKey}:${idx}`);
      if (idx === 1) {
        await first.promise;
      }
      order.push(`end:${agentKey}:${idx}`);
      return true;
    });

    // Enqueue two messages for the same agent
    queue.enqueueMessage("agent-a", "msg");
    queue.enqueueMessage("agent-a", "msg");

    // Let first dispatch begin
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(["start:agent-a:1"]);
    // Second has NOT started — serialized
    expect(callCount).toBe(1);

    // Complete first
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    // Second should now have started and completed
    expect(order).toContain("end:agent-a:1");
    expect(order).toContain("start:agent-a:2");
  });

  it("test 2: three messages for different agents processed concurrently", async () => {
    const queue = makeQueue();
    const active = new Set<string>();
    let maxSimultaneous = 0;

    const resolvers: Record<string, () => void> = {};

    queue.setProcessMessageFn(async (agentKey) => {
      active.add(agentKey);
      maxSimultaneous = Math.max(maxSimultaneous, active.size);
      await new Promise<void>((r) => (resolvers[agentKey] = r));
      active.delete(agentKey);
      return true;
    });

    queue.enqueueMessage("agent-a", "msg");
    queue.enqueueMessage("agent-b", "msg");
    queue.enqueueMessage("agent-c", "msg");

    await vi.advanceTimersByTimeAsync(0);

    // All three should be active simultaneously
    expect(maxSimultaneous).toBe(3);
    expect(active.size).toBe(3);
    expect(active.has("agent-a")).toBe(true);
    expect(active.has("agent-b")).toBe(true);
    expect(active.has("agent-c")).toBe(true);

    resolvers["agent-a"]!();
    resolvers["agent-b"]!();
    resolvers["agent-c"]!();
    await flush();
  });

  it("test 3: message sent while agent is active gets queued, processed after first completes", async () => {
    const queue = makeQueue();
    const starts: number[] = [];

    const first = deferred();
    let callCount = 0;

    queue.setProcessMessageFn(async () => {
      callCount++;
      starts.push(Date.now());
      if (callCount === 1) {
        await first.promise;
      }
      return true;
    });

    // Start first dispatch
    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    // Enqueue while first is still running
    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);

    // Second dispatch must not have started yet
    expect(callCount).toBe(1);

    // Complete first — second should start via drain
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(callCount).toBe(2);
  });
});

// ── Concurrency limit ─────────────────────────────────────────────────────────

describe("Concurrency limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("test 4: maxConcurrent=1 — only one agent active at a time", async () => {
    const queue = makeQueue({ maxConcurrent: 1 });
    const active = new Set<string>();
    let maxSimultaneous = 0;
    const processed: string[] = [];

    const resolvers: Record<string, () => void> = {};

    queue.setProcessMessageFn(async (agentKey) => {
      active.add(agentKey);
      maxSimultaneous = Math.max(maxSimultaneous, active.size);
      processed.push(agentKey);
      await new Promise<void>((r) => (resolvers[agentKey] = r));
      active.delete(agentKey);
      return true;
    });

    queue.enqueueMessage("agent-a", "msg");
    queue.enqueueMessage("agent-b", "msg");
    queue.enqueueMessage("agent-c", "msg");

    await vi.advanceTimersByTimeAsync(0);

    // Only one active
    expect(active.size).toBe(1);
    expect(maxSimultaneous).toBe(1);
    expect(processed).toEqual(["agent-a"]);

    // Release first — second starts
    resolvers["agent-a"]!();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(active.size).toBe(1);
    expect(processed.length).toBe(2);

    // Release second — third starts
    const secondKey = processed[1]!;
    resolvers[secondKey]!();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(processed.length).toBe(3);
    expect(maxSimultaneous).toBe(1); // never exceeded 1

    const thirdKey = processed[2]!;
    resolvers[thirdKey]!();
    await flush();
  });

  it("test 5: maxConcurrent=2 with 4 agents — first 2 active, others wait, drain as slots free", async () => {
    const queue = makeQueue({ maxConcurrent: 2 });
    const active = new Set<string>();
    let maxSimultaneous = 0;
    const processed: string[] = [];

    const resolvers: Record<string, () => void> = {};

    queue.setProcessMessageFn(async (agentKey) => {
      active.add(agentKey);
      maxSimultaneous = Math.max(maxSimultaneous, active.size);
      processed.push(agentKey);
      await new Promise<void>((r) => (resolvers[agentKey] = r));
      active.delete(agentKey);
      return true;
    });

    queue.enqueueMessage("agent-a", "msg");
    queue.enqueueMessage("agent-b", "msg");
    queue.enqueueMessage("agent-c", "msg");
    queue.enqueueMessage("agent-d", "msg");

    await vi.advanceTimersByTimeAsync(0);

    // Exactly 2 active
    expect(active.size).toBe(2);
    expect(processed.length).toBe(2);
    expect(maxSimultaneous).toBe(2);

    // Free one slot — a third agent should start
    resolvers["agent-a"]!();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(processed.length).toBe(3);
    expect(active.size).toBe(2);

    // Free another — fourth agent starts
    resolvers["agent-b"]!();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(processed.length).toBe(4);
    expect(maxSimultaneous).toBe(2); // never exceeded 2

    // Clean up
    for (const key of [...active]) {
      resolvers[key]?.();
    }
    await flush();
  });

  it("test 6: maxConcurrent=0 — nothing runs, everything queued to waiting list", async () => {
    const queue = makeQueue({ maxConcurrent: 0 });
    const processed: string[] = [];

    queue.setProcessMessageFn(async (agentKey) => {
      processed.push(agentKey);
      return true;
    });

    queue.enqueueMessage("agent-a", "msg");
    queue.enqueueMessage("agent-b", "msg");
    queue.enqueueTask("agent-c", "t1", async () => {
      processed.push("task-c");
    });

    await vi.advanceTimersByTimeAsync(100);
    await flush();

    // Nothing should have run
    expect(processed).toHaveLength(0);
    expect(queue.active).toBe(0);
  });
});

// ── Message injection ─────────────────────────────────────────────────────────

describe("Message injection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("test 7: message injected into idle dispatch — dispatch stays active, not restarted", async () => {
    const queue = makeQueue();
    const injections: string[] = [];
    let processCallCount = 0;

    const dispatch = deferred();

    queue.setProcessMessageFn(async () => {
      processCallCount++;
      await dispatch.promise;
      return true;
    });

    queue.setInjectMessageFn((agentKey, text) => {
      injections.push(`${agentKey}:${text}`);
      return true; // injection succeeded
    });

    // Start dispatch
    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);
    expect(processCallCount).toBe(1);

    // Mark idle
    queue.notifyIdle("agent-a");
    expect(queue.isIdle("agent-a")).toBe(true);

    // Inject — should go to injectMessageFn, NOT restart processMessagesFn
    queue.enqueueMessage("agent-a", "hello from outside");

    expect(injections).toHaveLength(1);
    expect(injections[0]).toBe("agent-a:hello from outside");
    // processMessagesFn was NOT called a second time
    expect(processCallCount).toBe(1);
    // Dispatch still active (not shut down or restarted)
    expect(queue.isActive("agent-a")).toBe(true);

    dispatch.resolve();
    await flush();
  });

  it("test 8: injection when injectMessageFn returns false — message queued as pending", async () => {
    const queue = makeQueue();
    let processCallCount = 0;

    const dispatches: Array<() => void> = [];

    queue.setProcessMessageFn(async () => {
      processCallCount++;
      await new Promise<void>((r) => dispatches.push(r));
      return true;
    });

    queue.setInjectMessageFn(() => false); // injection always fails

    // Start first dispatch
    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);
    expect(processCallCount).toBe(1);

    // Mark idle, then try to inject — should fail and queue as pending
    queue.notifyIdle("agent-a");
    queue.enqueueMessage("agent-a", "queued-msg");

    // Should NOT have injected (injectMessageFn returned false)
    // Should have queued instead → when current dispatch completes, a new one starts
    expect(processCallCount).toBe(1);

    // Complete first dispatch
    dispatches[0]!();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    // Second dispatch started because pendingMessages was true
    expect(processCallCount).toBe(2);

    dispatches[1]!();
    await flush();
  });

  it("test 9: injection when no injectMessageFn set — message queued as pending", async () => {
    const queue = makeQueue();
    let processCallCount = 0;

    const dispatches: Array<() => void> = [];

    queue.setProcessMessageFn(async () => {
      processCallCount++;
      await new Promise<void>((r) => dispatches.push(r));
      return true;
    });

    // No injectMessageFn set at all

    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);
    expect(processCallCount).toBe(1);

    // Mark idle, enqueue with text — no injector, should queue as pending
    queue.notifyIdle("agent-a");
    queue.enqueueMessage("agent-a", "needs-queuing");

    expect(processCallCount).toBe(1);

    dispatches[0]!();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(processCallCount).toBe(2);

    dispatches[1]!();
    await flush();
  });

  it("test 10: after injection, isIdle becomes false", async () => {
    const queue = makeQueue();

    const dispatch = deferred();
    queue.setProcessMessageFn(async () => {
      await dispatch.promise;
      return true;
    });
    queue.setInjectMessageFn(() => true);

    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);

    queue.notifyIdle("agent-a");
    expect(queue.isIdle("agent-a")).toBe(true);

    queue.enqueueMessage("agent-a", "wake-up");
    // Injection succeeded → idleWaiting set to false
    expect(queue.isIdle("agent-a")).toBe(false);
    // Still active though
    expect(queue.isActive("agent-a")).toBe(true);

    dispatch.resolve();
    await flush();
  });
});

// ── Task priority ─────────────────────────────────────────────────────────────

describe("Task priority", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("test 11: task enqueued while agent active — queued in pendingTasks", async () => {
    const queue = makeQueue();
    const taskRan = vi.fn();

    const dispatch = deferred();
    queue.setProcessMessageFn(async () => {
      await dispatch.promise;
      return true;
    });

    // Agent is active
    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.isActive("agent-a")).toBe(true);

    // Enqueue task — since agent is active it must be queued
    queue.enqueueTask("agent-a", "pending-task", taskRan);
    // Task should not have run yet
    expect(taskRan).not.toHaveBeenCalled();

    // Complete dispatch — task should drain and run
    dispatch.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(taskRan).toHaveBeenCalledOnce();
  });

  it("test 12: on drain, tasks run before pending messages", async () => {
    const queue = makeQueue();
    const order: string[] = [];

    const dispatches: Array<() => void> = [];

    queue.setProcessMessageFn(async (agentKey) => {
      order.push(`msg:${agentKey}`);
      await new Promise<void>((r) => dispatches.push(r));
      return true;
    });

    // Start a message dispatch
    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);

    // While active, enqueue a pending message AND a task
    queue.enqueueMessage("agent-a", "msg"); // pendingMessages = true
    queue.enqueueTask("agent-a", "task-1", async () => {
      order.push("task:agent-a");
    });

    // Complete first dispatch → drain
    dispatches[0]!();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    // Task must have run first (before any new message dispatch)
    const taskIdx = order.indexOf("task:agent-a");
    const secondMsgIdx = order.indexOf("msg:agent-a", 1);
    expect(taskIdx).toBeGreaterThanOrEqual(0);
    // If a second message dispatch started, the task index must be lower
    if (secondMsgIdx !== -1) {
      expect(taskIdx).toBeLessThan(secondMsgIdx);
    }

    // Clean up any remaining dispatches
    for (const r of dispatches) {
      try {
        r();
      } catch {
        /* already resolved */
      }
    }
    await flush();
  });

  it("test 13: task with same ID as running task — rejected (no double-queue)", async () => {
    const queue = makeQueue();
    const taskFn = vi.fn(async () => {});

    const dispatch = deferred();
    queue.setProcessMessageFn(async () => {
      await dispatch.promise;
      return true;
    });

    // Start a message dispatch so we can enqueue a task that runs
    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);

    // Enqueue task (goes to pending since agent is active)
    queue.enqueueTask("agent-a", "my-task", taskFn);
    // Try to enqueue again with same ID — should be rejected
    queue.enqueueTask("agent-a", "my-task", taskFn);

    dispatch.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    // taskFn should only be called once
    expect(taskFn).toHaveBeenCalledTimes(1);
  });

  it("test 14: task with same ID as pending task — rejected", async () => {
    const queue = makeQueue({ maxConcurrent: 0 }); // nothing runs
    const taskFn = vi.fn(async () => {});

    // Both tasks queue but only one should be stored
    queue.enqueueTask("agent-a", "dup-task", taskFn);
    queue.enqueueTask("agent-a", "dup-task", taskFn); // duplicate

    await vi.advanceTimersByTimeAsync(0);

    // Neither ran (maxConcurrent=0) but only one should be queued
    // Verify by bumping concurrency: create a new queue that will actually drain
    // We test indirectly: fn not called = queue respected the block
    expect(taskFn).not.toHaveBeenCalled();

    // Now test with a runnable queue to confirm only one copy runs
    const queue2 = makeQueue({ maxConcurrent: 5 });
    const fn2 = vi.fn(async () => {});
    const dispatch = deferred();
    queue2.setProcessMessageFn(async () => {
      await dispatch.promise;
      return true;
    });
    queue2.enqueueMessage("agent-b", "msg");
    await vi.advanceTimersByTimeAsync(0);

    // While agent-b is active, enqueue the same task ID twice
    queue2.enqueueTask("agent-b", "dup-id", fn2);
    queue2.enqueueTask("agent-b", "dup-id", fn2);

    dispatch.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    // Only one run despite two enqueue calls
    expect(fn2).toHaveBeenCalledTimes(1);
  });
});

// ── Idle preemption ───────────────────────────────────────────────────────────

describe("Idle preemption", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("test 15: notifyIdle with pending tasks → triggers onClose callback", async () => {
    const queue = makeQueue();
    const closes: string[] = [];
    queue.onClose = (key) => closes.push(key);

    const dispatch = deferred();
    queue.setProcessMessageFn(async () => {
      await dispatch.promise;
      return true;
    });

    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);

    // Enqueue task while active (goes to pendingTasks)
    queue.enqueueTask("agent-a", "t1", async () => {});

    // Notify idle — task is pending → should trigger onClose immediately
    queue.notifyIdle("agent-a");

    expect(closes).toContain("agent-a");

    dispatch.resolve();
    await flush();
  });

  it("test 16: notifyIdle with only pending messages → does NOT trigger onClose", async () => {
    const queue = makeQueue();
    const closes: string[] = [];
    queue.onClose = (key) => closes.push(key);

    const dispatch = deferred();
    queue.setProcessMessageFn(async () => {
      await dispatch.promise;
      return true;
    });

    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);

    // Enqueue pending message (no task)
    queue.enqueueMessage("agent-a", "msg");

    // Notify idle — no tasks pending → no onClose
    queue.notifyIdle("agent-a");

    expect(closes).toHaveLength(0);

    dispatch.resolve();
    await flush();
  });

  it("test 17: notifyIdle with nothing pending → no action", async () => {
    const queue = makeQueue();
    const closes: string[] = [];
    queue.onClose = (key) => closes.push(key);

    const dispatch = deferred();
    queue.setProcessMessageFn(async () => {
      await dispatch.promise;
      return true;
    });

    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);

    // Mark idle with no pending tasks or messages
    queue.notifyIdle("agent-a");

    // No close callback fired
    expect(closes).toHaveLength(0);

    dispatch.resolve();
    await flush();
  });
});

// ── Retry with backoff ────────────────────────────────────────────────────────

describe("Retry with backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("test 18: processMessagesFn returns false → retry scheduled", async () => {
    const queue = makeQueue();
    let callCount = 0;

    queue.setProcessMessageFn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    // Without advancing timers, no retry yet
    await flush();
    expect(callCount).toBe(1);

    // Advance to first retry window
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(callCount).toBe(2);
  });

  it("test 19: first retry at ~5000ms, second at ~10000ms (exponential backoff)", async () => {
    const queue = makeQueue();
    // Record fake-timer timestamps (ms elapsed since test start)
    const callTimes: number[] = [];
    const startTime = Date.now(); // capture fake-timer baseline after useFakeTimers

    queue.setProcessMessageFn(async () => {
      callTimes.push(Date.now() - startTime);
      return false;
    });

    queue.enqueueMessage("agent-a", "msg");

    // Initial call at t=0 (relative)
    await vi.advanceTimersByTimeAsync(0);
    expect(callTimes).toHaveLength(1);
    expect(callTimes[0]).toBe(0);

    // First retry: BASE_RETRY_MS * 2^(1-1) = 5000 * 1 = 5000ms
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(callTimes).toHaveLength(2);
    expect(callTimes[1]).toBe(5000);

    // Second retry: BASE_RETRY_MS * 2^(2-1) = 5000 * 2 = 10000ms
    await vi.advanceTimersByTimeAsync(10000);
    await flush();
    expect(callTimes).toHaveLength(3);
    expect(callTimes[2]).toBe(15000); // 5000 + 10000
  });

  it("test 20: after MAX_RETRIES (5), retries stop and retry count resets", async () => {
    const queue = makeQueue();
    let callCount = 0;

    queue.setProcessMessageFn(async () => {
      callCount++;
      return false;
    });

    queue.enqueueMessage("agent-a", "msg");

    // Run through all retry windows well past MAX_RETRIES
    // Delays: 5s, 10s, 20s, 40s, 80s = 5 retries → total 6 calls
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(100_000);
      await flush();
    }

    // 1 initial + 5 retries = 6 total, then stops
    expect(callCount).toBe(6);

    // After reset (retryCount goes back to 0), a new enqueueMessage should
    // be able to start fresh (not immediately, but on next external trigger)
    const countBefore = callCount;
    await vi.advanceTimersByTimeAsync(200_000);
    await flush();
    // No new calls since no new message was enqueued and retries are done
    expect(callCount).toBe(countBefore);
  });

  it("test 21: processMessagesFn throws → treated same as returning false", async () => {
    const queue = makeQueue();
    let callCount = 0;

    queue.setProcessMessageFn(async () => {
      callCount++;
      throw new Error("dispatch crashed");
    });

    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    // Retry should still be scheduled
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(callCount).toBe(2);
  });
});

// ── Shutdown ──────────────────────────────────────────────────────────────────

describe("Shutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("test 22: after shutdown(), enqueueMessage is a no-op", async () => {
    const queue = makeQueue();
    const fn = vi.fn(async () => true);
    queue.setProcessMessageFn(fn);

    queue.shutdown();
    queue.enqueueMessage("agent-a", "msg");
    queue.enqueueMessage("agent-b", "msg");

    await vi.advanceTimersByTimeAsync(100);
    await flush();

    expect(fn).not.toHaveBeenCalled();
  });

  it("test 23: after shutdown(), enqueueTask is a no-op", async () => {
    const queue = makeQueue();
    const taskFn = vi.fn(async () => {});

    queue.shutdown();
    queue.enqueueTask("agent-a", "t1", taskFn);

    await vi.advanceTimersByTimeAsync(100);
    await flush();

    expect(taskFn).not.toHaveBeenCalled();
  });

  it("test 24: isShutDown returns true after shutdown()", () => {
    const queue = makeQueue();

    expect(queue.isShutDown).toBe(false);
    queue.shutdown();
    expect(queue.isShutDown).toBe(true);
  });
});

// ── State tracking ────────────────────────────────────────────────────────────

describe("State tracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("test 25: isActive returns true during processing, false after", async () => {
    const queue = makeQueue();
    const dispatch = deferred();

    queue.setProcessMessageFn(async () => {
      await dispatch.promise;
      return true;
    });

    expect(queue.isActive("agent-a")).toBe(false);

    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.isActive("agent-a")).toBe(true);

    dispatch.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(queue.isActive("agent-a")).toBe(false);
  });

  it("test 26: isIdle transitions correctly around injection and completion", async () => {
    const queue = makeQueue();
    const dispatch = deferred();

    queue.setProcessMessageFn(async () => {
      await dispatch.promise;
      return true;
    });
    queue.setInjectMessageFn(() => true);

    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);

    // Not idle yet
    expect(queue.isIdle("agent-a")).toBe(false);

    // Mark idle
    queue.notifyIdle("agent-a");
    expect(queue.isIdle("agent-a")).toBe(true);

    // Inject message — clears idle flag
    queue.enqueueMessage("agent-a", "follow-up");
    expect(queue.isIdle("agent-a")).toBe(false);

    // Complete dispatch
    dispatch.resolve();
    await flush();

    // No longer active at all
    expect(queue.isActive("agent-a")).toBe(false);
    expect(queue.isIdle("agent-a")).toBe(false);
  });

  it("test 27: active count increments and decrements correctly across multiple agents", async () => {
    const queue = makeQueue();
    const resolvers: Record<string, () => void> = {};

    queue.setProcessMessageFn(async (agentKey) => {
      await new Promise<void>((r) => (resolvers[agentKey] = r));
      return true;
    });

    expect(queue.active).toBe(0);

    queue.enqueueMessage("agent-a", "msg");
    queue.enqueueMessage("agent-b", "msg");
    queue.enqueueMessage("agent-c", "msg");
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.active).toBe(3);

    resolvers["agent-a"]!();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(queue.active).toBe(2);

    resolvers["agent-b"]!();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(queue.active).toBe(1);

    resolvers["agent-c"]!();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(queue.active).toBe(0);
  });
});

// ── Error recovery ────────────────────────────────────────────────────────────

describe("Error recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("test 28: task throws error → agent state cleaned up, drain continues", async () => {
    const queue = makeQueue();
    const processed: string[] = [];

    queue.setProcessMessageFn(async (agentKey) => {
      processed.push(`msg:${agentKey}`);
      return true;
    });

    // Failing task for agent-a
    queue.enqueueTask("agent-a", "bad-task", async () => {
      throw new Error("task exploded");
    });

    await vi.advanceTimersByTimeAsync(0);
    await flush();

    // Agent should be inactive (state cleaned up)
    expect(queue.isActive("agent-a")).toBe(false);
    expect(queue.active).toBe(0);

    // Queue should still function — enqueue another agent
    queue.enqueueMessage("agent-b", "msg");
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(processed).toContain("msg:agent-b");

    // And agent-a should accept new work
    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(processed).toContain("msg:agent-a");
  });

  it("test 29: processMessagesFn throws → state cleaned up, retry scheduled", async () => {
    const queue = makeQueue();
    let callCount = 0;
    let lastActiveCount = -1;

    queue.setProcessMessageFn(async (agentKey) => {
      callCount++;
      // Capture active count mid-flight (should be 1)
      lastActiveCount = queue.active;
      throw new Error("processMessages crashed");
    });

    queue.enqueueMessage("agent-a", "msg");
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    // Active count was 1 during execution
    expect(lastActiveCount).toBe(1);
    // After crash, state must be cleaned up
    expect(queue.isActive("agent-a")).toBe(false);
    expect(queue.active).toBe(0);

    // Retry is scheduled — advance to first retry
    await vi.advanceTimersByTimeAsync(5000);
    await flush();

    expect(callCount).toBe(2); // retry happened
    expect(queue.active).toBe(0); // cleaned up again
  });
});
