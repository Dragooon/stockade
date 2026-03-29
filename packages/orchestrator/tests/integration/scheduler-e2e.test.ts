/**
 * E2E tests for the Task Scheduler.
 *
 * Tests the full scheduler lifecycle as a real user would experience it:
 * real cron parsing, real interval computation, full task lifecycle,
 * and integration with DispatchQueue.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeNextRun } from "../../src/scheduler/compute-next-run.js";
import {
  runScheduledTask,
  checkDueTasks,
  startSchedulerLoop,
  stopSchedulerLoop,
  _resetSchedulerForTests,
} from "../../src/scheduler/scheduler.js";
import { DispatchQueue } from "../../src/containers/queue.js";
import type {
  ScheduledTask,
  SchedulerConfig,
  TaskStore,
  TaskRunLog,
} from "../../src/scheduler/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const UTC_CONFIG: SchedulerConfig = {
  poll_interval_ms: 60_000,
  timezone: "UTC",
};

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    agentId: "agent-main",
    scope: "test:scope",
    prompt: "do something useful",
    script: null,
    schedule_type: "interval",
    schedule_value: "60000",
    context_mode: "agent",
    next_run: new Date(Date.now() - 1_000).toISOString(), // 1 second in past (due)
    last_run: null,
    last_result: null,
    status: "active",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

interface MockStore extends TaskStore {
  _logs: TaskRunLog[];
  _tasks: ScheduledTask[];
}

function makeMockStore(initial: ScheduledTask[] = []): MockStore {
  const tasks: ScheduledTask[] = initial.map((t) => ({ ...t }));
  const logs: TaskRunLog[] = [];

  return {
    _tasks: tasks,
    _logs: logs,
    getAllTasks: () => [...tasks],
    getTaskById: (id) => tasks.find((t) => t.id === id) ?? null,
    getDueTasks: () =>
      tasks.filter((t) => {
        if (t.status !== "active" || !t.next_run) return false;
        return new Date(t.next_run).getTime() <= Date.now();
      }),
    createTask: (task) => {
      tasks.push({ ...task, last_run: null, last_result: null } as ScheduledTask);
    },
    updateTask: (id, fields) => {
      const t = tasks.find((x) => x.id === id);
      if (t) Object.assign(t, fields);
    },
    updateTaskAfterRun: (id, nextRun, lastResult) => {
      const t = tasks.find((x) => x.id === id);
      if (t) {
        t.next_run = nextRun;
        t.last_result = lastResult;
        t.last_run = new Date().toISOString();
        if (t.schedule_type === "once") t.status = "completed";
      }
    },
    logTaskRun: (log) => logs.push(log),
    deleteTask: (id) => {
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx >= 0) tasks.splice(idx, 1);
    },
  };
}

// ── Lifecycle management ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  _resetSchedulerForTests();
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// computeNextRun — CRON
// ─────────────────────────────────────────────────────────────────────────────

describe("computeNextRun — cron", () => {
  it("1. every-hour cron → next occurrence has minutes=0 and is in the future", () => {
    const task = makeTask({
      schedule_type: "cron",
      schedule_value: "0 * * * *",
    });

    const next = computeNextRun(task, UTC_CONFIG);
    expect(next).not.toBeNull();

    const nextDate = new Date(next!);
    expect(nextDate.getUTCMinutes()).toBe(0);
    expect(nextDate.getTime()).toBeGreaterThan(Date.now());
  });

  it("2. every-5-min cron → next is within 5 minutes", () => {
    const task = makeTask({
      schedule_type: "cron",
      schedule_value: "*/5 * * * *",
    });

    const next = computeNextRun(task, UTC_CONFIG);
    expect(next).not.toBeNull();

    const nowMs = Date.now();
    const nextMs = new Date(next!).getTime();
    expect(nextMs).toBeGreaterThan(nowMs);
    expect(nextMs - nowMs).toBeLessThanOrEqual(5 * 60 * 1_000);
  });

  it("3. daily-noon cron → next has UTC hours=12", () => {
    const task = makeTask({
      schedule_type: "cron",
      schedule_value: "0 12 * * *",
    });

    const next = computeNextRun(task, UTC_CONFIG);
    expect(next).not.toBeNull();

    const nextDate = new Date(next!);
    expect(nextDate.getUTCHours()).toBe(12);
    expect(nextDate.getUTCMinutes()).toBe(0);
  });

  it("3a. day-of-week cron (MON at 9AM) → returns next Monday", () => {
    // Set fake clock to a known Wednesday: 2025-06-04 12:00:00 UTC
    vi.setSystemTime(new Date("2025-06-04T12:00:00Z"));

    const task = makeTask({
      schedule_type: "cron",
      schedule_value: "0 9 * * MON",
    });

    const next = computeNextRun(task, UTC_CONFIG);
    expect(next).not.toBeNull();

    const nextDate = new Date(next!);
    // Next Monday after Wed June 4 is Monday June 9
    expect(nextDate.getUTCDay()).toBe(1); // 1 = Monday
    expect(nextDate.getUTCHours()).toBe(9);
    expect(nextDate.getUTCMinutes()).toBe(0);
    expect(nextDate.getTime()).toBeGreaterThan(Date.now());
  });

  it("4. monthly-1st-midnight cron → next is the 1st of a month", () => {
    const task = makeTask({
      schedule_type: "cron",
      schedule_value: "0 0 1 * *",
    });

    const next = computeNextRun(task, UTC_CONFIG);
    expect(next).not.toBeNull();

    const nextDate = new Date(next!);
    expect(nextDate.getUTCDate()).toBe(1);
    expect(nextDate.getUTCHours()).toBe(0);
    expect(nextDate.getUTCMinutes()).toBe(0);
  });

  it("5. timezone America/New_York shifts the computed time vs UTC", () => {
    const task = makeTask({
      schedule_type: "cron",
      schedule_value: "0 12 * * *", // noon in local TZ
    });

    const utcNext = computeNextRun(task, { ...UTC_CONFIG, timezone: "UTC" });
    const nyNext = computeNextRun(task, {
      ...UTC_CONFIG,
      timezone: "America/New_York",
    });

    expect(utcNext).not.toBeNull();
    expect(nyNext).not.toBeNull();

    // noon UTC and noon NY are different UTC timestamps (NY is behind UTC)
    // Normalize to same day by comparing the hour-of-day in UTC
    const utcHour = new Date(utcNext!).getUTCHours();
    const nyHour = new Date(nyNext!).getUTCHours();

    // noon UTC → 12:00 UTC; noon NY → 16:00 or 17:00 UTC (depending on DST)
    expect(utcHour).toBe(12);
    expect(nyHour).toBeGreaterThanOrEqual(16);
    expect(nyHour).toBeLessThanOrEqual(17);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeNextRun — INTERVAL
// ─────────────────────────────────────────────────────────────────────────────

describe("computeNextRun — interval", () => {
  it("6. simple 60s interval → next is anchor + 60000", () => {
    const anchor = 1_000_000;
    const now = anchor + 500; // barely past the anchor, not past anchor+interval

    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "60000",
      next_run: new Date(anchor).toISOString(),
    });

    const next = computeNextRun(task, UTC_CONFIG, now);
    expect(new Date(next!).getTime()).toBe(anchor + 60_000);
  });

  it("7. anchor 5 intervals in the past → skips missed, lands on next future boundary", () => {
    const anchor = 1_000_000;
    const interval = 60_000;
    // 5 intervals have been missed: now is just past anchor + 5*interval
    const now = anchor + interval * 5 + 100;

    const task = makeTask({
      schedule_type: "interval",
      schedule_value: String(interval),
      next_run: new Date(anchor).toISOString(),
    });

    const next = computeNextRun(task, UTC_CONFIG, now);
    const nextMs = new Date(next!).getTime();

    // Should land on anchor + 6*interval (the first future boundary)
    expect(nextMs).toBe(anchor + interval * 6);
    expect(nextMs).toBeGreaterThan(now);
  });

  it("8. anchor exactly at now → skips to anchor + interval (not now)", () => {
    const anchor = 1_000_000;
    const interval = 60_000;
    const now = anchor + interval; // exactly at the first boundary

    const task = makeTask({
      schedule_type: "interval",
      schedule_value: String(interval),
      next_run: new Date(anchor).toISOString(),
    });

    const next = computeNextRun(task, UTC_CONFIG, now);
    const nextMs = new Date(next!).getTime();

    // anchor+interval <= now, so must skip to anchor+2*interval
    expect(nextMs).toBe(anchor + interval * 2);
    expect(nextMs).toBeGreaterThan(now);
  });

  it("9. drift prevention: next is always on anchor+N*interval boundary, never Date.now()+interval", () => {
    const anchor = 2_000_000;
    const interval = 60_000;
    // Simulate wakeup after being down for 3.7 intervals
    const now = anchor + Math.floor(interval * 3.7);

    const task = makeTask({
      schedule_type: "interval",
      schedule_value: String(interval),
      next_run: new Date(anchor).toISOString(),
    });

    const next = computeNextRun(task, UTC_CONFIG, now);
    const nextMs = new Date(next!).getTime();

    // Must be exactly on a boundary of anchor + N*interval
    const offset = nextMs - anchor;
    expect(offset % interval).toBe(0);

    // And must NOT equal Date.now() + interval (which would be drift)
    expect(nextMs).not.toBe(now + interval);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeNextRun — EDGE CASES
// ─────────────────────────────────────────────────────────────────────────────

describe("computeNextRun — edge cases", () => {
  it("10. once → returns null", () => {
    const task = makeTask({ schedule_type: "once", schedule_value: "" });
    expect(computeNextRun(task, UTC_CONFIG)).toBeNull();
  });

  it('11. interval value "0" → fallback to now + 60000', () => {
    const now = 5_000_000;
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "0",
      next_run: new Date(now).toISOString(),
    });

    const next = computeNextRun(task, UTC_CONFIG, now);
    expect(new Date(next!).getTime()).toBe(now + 60_000);
  });

  it('12. interval value "-1000" → fallback to now + 60000', () => {
    const now = 5_000_000;
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "-1000",
      next_run: new Date(now).toISOString(),
    });

    const next = computeNextRun(task, UTC_CONFIG, now);
    expect(new Date(next!).getTime()).toBe(now + 60_000);
  });

  it('13. interval value "abc" → fallback to now + 60000', () => {
    const now = 5_000_000;
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "abc",
      next_run: new Date(now).toISOString(),
    });

    const next = computeNextRun(task, UTC_CONFIG, now);
    expect(new Date(next!).getTime()).toBe(now + 60_000);
  });

  it("14. unknown schedule_type → returns null", () => {
    const task = makeTask({
      schedule_type: "unknown" as any,
      schedule_value: "60000",
    });
    expect(computeNextRun(task, UTC_CONFIG)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runScheduledTask — LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

describe("runScheduledTask — lifecycle", () => {
  it("15. successful execution → logs success, stores result, computes next_run", async () => {
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "60000",
      next_run: new Date(Date.now() - 1_000).toISOString(),
    });
    const store = makeMockStore([task]);

    await runScheduledTask(task, {
      store,
      config: UTC_CONFIG,
      executeTask: async () => "task output",
    });

    const logs = store._logs;
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("success");
    expect(logs[0].result).toBe("task output");
    expect(logs[0].error).toBeNull();

    const updated = store.getTaskById("t1")!;
    expect(updated.last_result).toBe("task output");
    expect(updated.next_run).not.toBeNull();
    expect(new Date(updated.next_run!).getTime()).toBeGreaterThan(Date.now());
  });

  it("16. failed execution (throws) → logs error with message, stores 'Error: ...' summary", async () => {
    const task = makeTask();
    const store = makeMockStore([task]);

    await runScheduledTask(task, {
      store,
      config: UTC_CONFIG,
      executeTask: async () => {
        throw new Error("something went wrong");
      },
    });

    const logs = store._logs;
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("error");
    expect(logs[0].error).toBe("something went wrong");
    expect(logs[0].result).toBeNull();

    const updated = store.getTaskById("t1")!;
    expect(updated.last_result).toBe("Error: something went wrong");
  });

  it("17. once task → next_run set to null, status becomes 'completed'", async () => {
    const task = makeTask({
      schedule_type: "once",
      schedule_value: "",
    });
    const store = makeMockStore([task]);

    await runScheduledTask(task, {
      store,
      config: UTC_CONFIG,
      executeTask: async () => "done once",
    });

    const updated = store.getTaskById("t1")!;
    expect(updated.next_run).toBeNull();
    expect(updated.status).toBe("completed");
  });

  it("18. result truncated to 200 chars if longer", async () => {
    const task = makeTask();
    const store = makeMockStore([task]);
    const longOutput = "A".repeat(500);

    await runScheduledTask(task, {
      store,
      config: UTC_CONFIG,
      executeTask: async () => longOutput,
    });

    const updated = store.getTaskById("t1")!;
    expect(updated.last_result).toHaveLength(200);
    expect(updated.last_result).toBe("A".repeat(200));
  });

  it("19. duration logged in ms (≥0)", async () => {
    const task = makeTask();
    const store = makeMockStore([task]);

    await runScheduledTask(task, {
      store,
      config: UTC_CONFIG,
      executeTask: async () => "ok",
    });

    const logs = store._logs;
    expect(logs[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(logs[0].duration_ms)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkDueTasks
// ─────────────────────────────────────────────────────────────────────────────

describe("checkDueTasks", () => {
  it("20. due task (next_run in past) → dispatched", () => {
    const task = makeTask({
      next_run: new Date(Date.now() - 5_000).toISOString(),
    });
    const store = makeMockStore([task]);
    const dispatched: string[] = [];

    const count = checkDueTasks({
      store,
      config: UTC_CONFIG,
      executeTask: async () => "ok",
      enqueueTask: (_agentKey, taskId) => dispatched.push(taskId),
    });

    expect(count).toBe(1);
    expect(dispatched).toEqual(["t1"]);
  });

  it("21. future task (next_run in future) → skipped", () => {
    const task = makeTask({
      next_run: new Date(Date.now() + 60_000).toISOString(),
    });
    const store = makeMockStore([task]);
    const dispatched: string[] = [];

    const count = checkDueTasks({
      store,
      config: UTC_CONFIG,
      executeTask: async () => "ok",
      enqueueTask: (_agentKey, taskId) => dispatched.push(taskId),
    });

    expect(count).toBe(0);
    expect(dispatched).toHaveLength(0);
  });

  it("22. paused task → skipped even if due", () => {
    const task = makeTask({
      status: "paused",
      next_run: new Date(Date.now() - 1_000).toISOString(),
    });
    const store = makeMockStore([task]);
    const dispatched: string[] = [];

    const count = checkDueTasks({
      store,
      config: UTC_CONFIG,
      executeTask: async () => "ok",
      enqueueTask: (_agentKey, taskId) => dispatched.push(taskId),
    });

    expect(count).toBe(0);
    expect(dispatched).toHaveLength(0);
  });

  it("23. completed task → skipped", () => {
    const task = makeTask({
      status: "completed",
      next_run: new Date(Date.now() - 1_000).toISOString(),
    });
    const store = makeMockStore([task]);
    const dispatched: string[] = [];

    const count = checkDueTasks({
      store,
      config: UTC_CONFIG,
      executeTask: async () => "ok",
      enqueueTask: (_agentKey, taskId) => dispatched.push(taskId),
    });

    expect(count).toBe(0);
    expect(dispatched).toHaveLength(0);
  });

  it("24. multiple due tasks → all dispatched", () => {
    const t1 = makeTask({ id: "t1", agentId: "agent-a" });
    const t2 = makeTask({ id: "t2", agentId: "agent-b" });
    const t3 = makeTask({ id: "t3", agentId: "agent-c" });
    const store = makeMockStore([t1, t2, t3]);
    const dispatched: string[] = [];

    const count = checkDueTasks({
      store,
      config: UTC_CONFIG,
      executeTask: async () => "ok",
      enqueueTask: (_agentKey, taskId) => dispatched.push(taskId),
    });

    expect(count).toBe(3);
    expect(dispatched).toContain("t1");
    expect(dispatched).toContain("t2");
    expect(dispatched).toContain("t3");
  });

  it("25. task re-checked from store before dispatch (guards concurrent modification)", () => {
    // Task starts as active (returned by getDueTasks), but is paused by the time
    // getTaskById is called — simulating a concurrent modification.
    const task = makeTask({
      next_run: new Date(Date.now() - 1_000).toISOString(),
    });

    let getByIdCalled = false;
    const store = makeMockStore([task]);
    const originalGetById = store.getTaskById.bind(store);
    store.getTaskById = (id: string) => {
      const t = originalGetById(id);
      if (!getByIdCalled && t) {
        getByIdCalled = true;
        // Simulate concurrent pause
        return { ...t, status: "paused" as const };
      }
      return t;
    };

    const dispatched: string[] = [];
    const count = checkDueTasks({
      store,
      config: UTC_CONFIG,
      executeTask: async () => "ok",
      enqueueTask: (_agentKey, taskId) => dispatched.push(taskId),
    });

    // Should NOT dispatch because re-check shows it paused
    expect(count).toBe(0);
    expect(dispatched).toHaveLength(0);
    expect(getByIdCalled).toBe(true);
  });

  it("26. with enqueueTask fn → routes through queue", () => {
    const task = makeTask();
    const store = makeMockStore([task]);
    const queueCalls: Array<{ agentKey: string; taskId: string }> = [];

    checkDueTasks({
      store,
      config: UTC_CONFIG,
      executeTask: async () => "ok",
      enqueueTask: (agentKey, taskId, _fn) => {
        queueCalls.push({ agentKey, taskId });
      },
    });

    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0].agentKey).toBe("agent-main");
    expect(queueCalls[0].taskId).toBe("t1");
  });

  it("27. without enqueueTask fn → runs directly", async () => {
    const task = makeTask();
    const store = makeMockStore([task]);
    const executed = vi.fn(async () => "direct");

    const count = checkDueTasks({
      store,
      config: UTC_CONFIG,
      executeTask: executed,
      // no enqueueTask
    });

    expect(count).toBe(1);

    // Allow the async execution to settle
    await vi.advanceTimersByTimeAsync(0);
    expect(executed).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// startSchedulerLoop / stopSchedulerLoop
// ─────────────────────────────────────────────────────────────────────────────

describe("startSchedulerLoop", () => {
  it("28. polls at configured interval", () => {
    const task = makeTask({ id: "t1" });
    const store = makeMockStore([task]);
    const dispatched: string[] = [];

    startSchedulerLoop({
      store,
      config: { ...UTC_CONFIG, poll_interval_ms: 1_000 },
      executeTask: async () => "ok",
      enqueueTask: (_agentKey, taskId) => dispatched.push(taskId),
    });

    // First poll fires immediately — t1 is due
    const afterFirstPoll = dispatched.length;
    expect(afterFirstPoll).toBeGreaterThanOrEqual(1);

    // Advance past poll interval — should have polled again
    vi.advanceTimersByTime(1_000);
    expect(dispatched.length).toBeGreaterThan(afterFirstPoll);
  });

  it("29. idempotent — second call is a no-op", () => {
    const store = makeMockStore([]);
    let checkCount = 0;
    const getDueTasks = store.getDueTasks.bind(store);
    store.getDueTasks = () => {
      checkCount++;
      return getDueTasks();
    };

    const deps = {
      store,
      config: { ...UTC_CONFIG, poll_interval_ms: 500 },
      executeTask: async () => "ok",
    };

    startSchedulerLoop(deps);
    startSchedulerLoop(deps); // second call — no-op

    const countAfterFirstPoll = checkCount;

    // Advance one interval — only one timer should be running
    vi.advanceTimersByTime(500);
    const countAfterSecondPoll = checkCount;

    // If two loops were running, we'd see 2x the polls
    // With idempotent behavior, increment should be exactly 1
    expect(countAfterSecondPoll - countAfterFirstPoll).toBe(1);
  });

  it("30. stopSchedulerLoop stops polling", () => {
    const store = makeMockStore([]);
    let checkCount = 0;
    const getDueTasks = store.getDueTasks.bind(store);
    store.getDueTasks = () => {
      checkCount++;
      return getDueTasks();
    };

    startSchedulerLoop({
      store,
      config: { ...UTC_CONFIG, poll_interval_ms: 500 },
      executeTask: async () => "ok",
    });

    // Initial poll fires
    const countBeforeStop = checkCount;

    stopSchedulerLoop();

    // Advance time — no more polls should happen
    vi.advanceTimersByTime(2_000);
    expect(checkCount).toBe(countBeforeStop); // no additional polls
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler + DispatchQueue integration
// ─────────────────────────────────────────────────────────────────────────────

describe("Scheduler + DispatchQueue integration", () => {
  it("31. due task dispatched via DispatchQueue.enqueueTask", async () => {
    const task = makeTask({ id: "t1", agentId: "agent-x" });
    const store = makeMockStore([task]);
    const executed = vi.fn(async () => "queue result");

    const queue = new DispatchQueue({ maxConcurrent: 5 });

    checkDueTasks({
      store,
      config: UTC_CONFIG,
      executeTask: executed,
      enqueueTask: (agentKey, taskId, fn) => queue.enqueueTask(agentKey, taskId, fn),
    });

    // Let the queue process the task
    await vi.advanceTimersByTimeAsync(0);

    expect(executed).toHaveBeenCalledOnce();
    expect(executed).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
  });

  it("32. two due tasks for same agent → serialized through queue", async () => {
    const t1 = makeTask({ id: "t1", agentId: "shared-agent" });
    const t2 = makeTask({ id: "t2", agentId: "shared-agent" });
    const store = makeMockStore([t1, t2]);

    const order: string[] = [];
    const resolvers: Record<string, () => void> = {};

    const queue = new DispatchQueue({ maxConcurrent: 5 });

    checkDueTasks({
      store,
      config: UTC_CONFIG,
      executeTask: async (task) => {
        order.push(`start:${task.id}`);
        await new Promise<void>((r) => (resolvers[task.id] = r));
        order.push(`end:${task.id}`);
        return "done";
      },
      enqueueTask: (agentKey, taskId, fn) => queue.enqueueTask(agentKey, taskId, fn),
    });

    // Let first task start
    await vi.advanceTimersByTimeAsync(0);

    // Only one task should be running (serialized per agent)
    const startedAfterFirstTick = order.filter((o) => o.startsWith("start:"));
    expect(startedAfterFirstTick).toHaveLength(1);

    // Complete first task
    resolvers["t1"]!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Second task should now be running
    expect(order).toContain("end:t1");
    expect(order).toContain("start:t2");

    // Complete second task
    resolvers["t2"]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toContain("end:t2");
  });

  it("33. due tasks for different agents → can run concurrently (up to maxConcurrent)", async () => {
    const t1 = makeTask({ id: "t1", agentId: "agent-alpha" });
    const t2 = makeTask({ id: "t2", agentId: "agent-beta" });
    const t3 = makeTask({ id: "t3", agentId: "agent-gamma" });
    const store = makeMockStore([t1, t2, t3]);

    const activeSet = new Set<string>();
    let maxConcurrentObserved = 0;
    const resolvers: Record<string, () => void> = {};

    const queue = new DispatchQueue({ maxConcurrent: 3 });

    checkDueTasks({
      store,
      config: UTC_CONFIG,
      executeTask: async (task) => {
        activeSet.add(task.id);
        maxConcurrentObserved = Math.max(maxConcurrentObserved, activeSet.size);
        await new Promise<void>((r) => (resolvers[task.id] = r));
        activeSet.delete(task.id);
        return "done";
      },
      enqueueTask: (agentKey, taskId, fn) => queue.enqueueTask(agentKey, taskId, fn),
    });

    // Let all tasks start
    await vi.advanceTimersByTimeAsync(0);

    // All three different-agent tasks should be running concurrently
    expect(activeSet.size).toBe(3);
    expect(maxConcurrentObserved).toBe(3);

    // Clean up
    resolvers["t1"]!();
    resolvers["t2"]!();
    resolvers["t3"]!();
    await vi.advanceTimersByTimeAsync(0);
  });
});
