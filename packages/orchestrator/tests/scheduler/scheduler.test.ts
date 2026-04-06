import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkDueTasks,
  runScheduledTask,
  startSchedulerLoop,
  _resetSchedulerForTests,
} from "../../src/scheduler/scheduler.js";
import type {
  ScheduledTask,
  SchedulerConfig,
  TaskStore,
  TaskRunLog,
} from "../../src/scheduler/types.js";

const config: SchedulerConfig = {
  poll_interval_ms: 60000,
  timezone: "UTC",
};

function makeTask(overrides?: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "t1",
    agentId: "main",
    scope: "test:scope",
    userId: "user1",
    userPlatform: "terminal",
    prompt: "do something",
    schedule_type: "interval",
    schedule_value: "60000",
    context_mode: "isolated",
    next_run: new Date(Date.now() - 1000).toISOString(), // 1s ago (due)
    last_run: null,
    last_result: null,
    status: "active",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockStore(tasks: ScheduledTask[] = []): TaskStore {
  const store: ScheduledTask[] = [...tasks];
  const logs: TaskRunLog[] = [];

  return {
    getAllTasks: () => [...store],
    getTaskById: (id) => store.find((t) => t.id === id) ?? null,
    getDueTasks: () => store.filter((t) => {
      if (t.status !== "active" || !t.next_run) return false;
      return new Date(t.next_run).getTime() <= Date.now();
    }),
    createTask: (task) => {
      store.push({ ...task, last_run: null, last_result: null } as ScheduledTask);
    },
    updateTask: (id, fields) => {
      const t = store.find((t) => t.id === id);
      if (t) Object.assign(t, fields);
    },
    updateTaskAfterRun: (id, nextRun, lastResult) => {
      const t = store.find((t) => t.id === id);
      if (t) {
        t.next_run = nextRun;
        t.last_result = lastResult;
        t.last_run = new Date().toISOString();
        if (t.schedule_type === "once") t.status = "completed";
      }
    },
    logTaskRun: (log) => logs.push(log),
    deleteTask: (id) => {
      const idx = store.findIndex((t) => t.id === id);
      if (idx >= 0) store.splice(idx, 1);
    },
    // Expose logs for assertions
    _logs: logs,
  } as TaskStore & { _logs: TaskRunLog[] };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  _resetSchedulerForTests();
  vi.useRealTimers();
});

// ── runScheduledTask ──

describe("runScheduledTask", () => {
  it("executes task and logs success", async () => {
    const task = makeTask();
    const store = makeMockStore([task]);

    await runScheduledTask(task, {
      store,
      config,
      executeTask: async () => "done!",
    });

    const logs = (store as any)._logs as TaskRunLog[];
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("success");
    expect(logs[0].result).toBe("done!");
    expect(logs[0].error).toBeNull();
    expect(logs[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("logs error when execution fails", async () => {
    const task = makeTask();
    const store = makeMockStore([task]);

    await runScheduledTask(task, {
      store,
      config,
      executeTask: async () => {
        throw new Error("boom");
      },
    });

    const logs = (store as any)._logs as TaskRunLog[];
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("error");
    expect(logs[0].error).toBe("boom");
    expect(logs[0].result).toBeNull();
  });

  it("computes next run for interval tasks", async () => {
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "60000",
      next_run: new Date(Date.now()).toISOString(),
    });
    const store = makeMockStore([task]);

    await runScheduledTask(task, {
      store,
      config,
      executeTask: async () => "ok",
    });

    // Task should have a new next_run
    const updated = store.getTaskById("t1");
    expect(updated!.next_run).toBeTruthy();
    expect(new Date(updated!.next_run!).getTime()).toBeGreaterThan(Date.now());
  });

  it("sets next_run to null for once tasks", async () => {
    const task = makeTask({
      schedule_type: "once",
      schedule_value: "",
    });
    const store = makeMockStore([task]);

    await runScheduledTask(task, {
      store,
      config,
      executeTask: async () => "ok",
    });

    const updated = store.getTaskById("t1");
    expect(updated!.next_run).toBeNull();
    expect(updated!.status).toBe("completed");
  });

  it("truncates long results to 200 chars", async () => {
    const task = makeTask();
    const store = makeMockStore([task]);
    const longResult = "x".repeat(500);

    await runScheduledTask(task, {
      store,
      config,
      executeTask: async () => longResult,
    });

    const updated = store.getTaskById("t1");
    expect(updated!.last_result!.length).toBeLessThanOrEqual(200);
  });
});

// ── checkDueTasks ──

describe("checkDueTasks", () => {
  it("dispatches due tasks", () => {
    const task = makeTask();
    const store = makeMockStore([task]);
    const enqueued: string[] = [];

    const count = checkDueTasks({
      store,
      config,
      executeTask: async () => "ok",
      enqueueTask: (agentKey, taskId, fn) => {
        enqueued.push(taskId);
      },
    });

    expect(count).toBe(1);
    expect(enqueued).toEqual(["t1"]);
  });

  it("skips tasks that are not active", () => {
    const task = makeTask({ status: "paused" });
    const store = makeMockStore([task]);

    const count = checkDueTasks({
      store,
      config,
      executeTask: async () => "ok",
    });

    expect(count).toBe(0);
  });

  it("skips tasks not yet due", () => {
    const task = makeTask({
      next_run: new Date(Date.now() + 999999).toISOString(),
    });
    const store = makeMockStore([task]);

    const count = checkDueTasks({
      store,
      config,
      executeTask: async () => "ok",
    });

    expect(count).toBe(0);
  });

  it("runs tasks directly when no enqueueTask provided", async () => {
    const task = makeTask();
    const store = makeMockStore([task]);
    const executed = vi.fn(async () => "ok");

    const count = checkDueTasks({
      store,
      config,
      executeTask: executed,
    });

    expect(count).toBe(1);
    // Direct execution is async, let it resolve
    await vi.advanceTimersByTimeAsync(0);
    expect(executed).toHaveBeenCalledOnce();
  });

  it("dispatches multiple due tasks", () => {
    const t1 = makeTask({ id: "t1", agentId: "main" });
    const t2 = makeTask({ id: "t2", agentId: "researcher" });
    const store = makeMockStore([t1, t2]);
    const enqueued: string[] = [];

    const count = checkDueTasks({
      store,
      config,
      executeTask: async () => "ok",
      enqueueTask: (agentKey, taskId) => enqueued.push(taskId),
    });

    expect(count).toBe(2);
    expect(enqueued).toEqual(["t1", "t2"]);
  });
});

// ── startSchedulerLoop ──

describe("startSchedulerLoop", () => {
  it("polls at configured interval", async () => {
    // Use two tasks so one is always due after the first poll
    const t1 = makeTask({ id: "t1" });
    const t2 = makeTask({ id: "t2", next_run: new Date(Date.now() + 500).toISOString() });
    const store = makeMockStore([t1, t2]);
    let checkCount = 0;

    startSchedulerLoop({
      store,
      config: { ...config, poll_interval_ms: 1000 },
      executeTask: async () => {
        checkCount++;
        return "ok";
      },
      enqueueTask: (_agentKey, _taskId, fn) => {
        checkCount++;
        fn(); // run inline
      },
    });

    // First check happens immediately (t1 is due)
    const initialCount = checkCount;
    expect(initialCount).toBeGreaterThanOrEqual(1);

    // Advance past poll interval — t2 should now be due
    vi.advanceTimersByTime(1000);

    expect(checkCount).toBeGreaterThan(initialCount);
  });

  it("is idempotent — second call is a no-op", () => {
    const store = makeMockStore([]);
    const deps = {
      store,
      config,
      executeTask: async () => "ok",
    };

    startSchedulerLoop(deps);
    startSchedulerLoop(deps); // should not throw or start second loop
  });
});
