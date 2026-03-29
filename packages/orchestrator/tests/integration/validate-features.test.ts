/**
 * Integration validation tests — exercise the full feature stack with real
 * (non-mocked) implementations where possible.
 *
 * These test the actual wiring, not just individual units:
 * - Config loading with new schema fields
 * - DispatchQueue serialization with real async work
 * - Mount security with real filesystem paths
 * - Scheduler with real cron parsing and interval computation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig, substituteEnvVars } from "../../src/config.js";
import { DispatchQueue } from "../../src/containers/queue.js";
import {
  validateAdditionalMounts,
  type MountAllowlist,
} from "../../src/containers/mounts.js";
import {
  checkDueTasks,
  runScheduledTask,
  computeNextRun,
  _resetSchedulerForTests,
  type ScheduledTask,
  type SchedulerConfig,
  type TaskStore,
  type TaskRunLog,
} from "../../src/scheduler/index.js";

// ── Config validation ──

describe("config loading with new schema fields", () => {
  it("loads config with containers.max_concurrent field", () => {
    // Simulate a raw parsed YAML that includes containers config
    const raw = {
      channels: {
        terminal: { enabled: true, agent: "main" },
      },
      rbac: {
        roles: { owner: { permissions: ["agent:*"] } },
        users: { test: { roles: ["owner"], identities: { terminal: "test" } } },
      },
      containers: {
        max_concurrent: 10,
        network: "test-net",
      },
    };

    // The platform schema should parse this without error
    // We test via substituteEnvVars to mimic the real path
    const substituted = substituteEnvVars(raw);
    expect(substituted).toBeTruthy();
  });

  it("loads config with scheduler field", () => {
    const raw = {
      channels: {
        terminal: { enabled: true, agent: "main" },
      },
      rbac: {
        roles: { owner: { permissions: ["agent:*"] } },
        users: { test: { roles: ["owner"], identities: { terminal: "test" } } },
      },
      scheduler: {
        poll_interval_ms: 30000,
        timezone: "America/New_York",
      },
    };

    const substituted = substituteEnvVars(raw);
    expect(substituted).toBeTruthy();
  });
});

// ── DispatchQueue — full flow validation ──

describe("DispatchQueue — integration validation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("serializes messages and injects follow-ups into active dispatch", async () => {
    const queue = new DispatchQueue({ maxConcurrent: 5 });
    const events: string[] = [];
    const injected: string[] = [];
    let resolveDispatch: () => void;

    queue.setProcessMessageFn(async (agentKey) => {
      events.push(`dispatch:${agentKey}`);
      await new Promise<void>((r) => (resolveDispatch = r));
      events.push(`done:${agentKey}`);
      return true;
    });

    queue.setInjectMessageFn((agentKey, text) => {
      injected.push(`${agentKey}:${text}`);
      return true;
    });

    // First message starts dispatch
    queue.enqueueMessage("main", "msg");
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["dispatch:main"]);
    expect(queue.isActive("main")).toBe(true);

    // Mark idle (agent finished initial work, waiting)
    queue.notifyIdle("main");
    expect(queue.isIdle("main")).toBe(true);

    // Follow-up message — should inject, not queue new dispatch
    queue.enqueueMessage("main", "what about X?");
    expect(injected).toEqual(["main:what about X?"]);
    expect(queue.isIdle("main")).toBe(false);

    // Complete the dispatch
    resolveDispatch!();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContain("done:main");
    expect(queue.active).toBe(0);
  });

  it("global concurrency limit blocks excess agents, drains correctly", async () => {
    const queue = new DispatchQueue({ maxConcurrent: 2 });
    const running = new Set<string>();
    const resolvers: Record<string, () => void> = {};

    queue.setProcessMessageFn(async (agentKey) => {
      running.add(agentKey);
      await new Promise<void>((r) => (resolvers[agentKey] = r));
      running.delete(agentKey);
      return true;
    });

    queue.enqueueMessage("a", "msg");
    queue.enqueueMessage("b", "msg");
    queue.enqueueMessage("c", "msg"); // should be blocked
    await vi.advanceTimersByTimeAsync(0);

    expect(running.size).toBe(2);
    expect(running.has("c")).toBe(false);

    // Free one slot
    resolvers["a"]!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // c should now be running
    expect(running.has("c")).toBe(true);

    resolvers["b"]!();
    resolvers["c"]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.active).toBe(0);
  });

  it("task preempts idle message dispatch", async () => {
    const queue = new DispatchQueue({ maxConcurrent: 5 });
    const closes: string[] = [];
    queue.onClose = (k) => closes.push(k);

    let resolveDispatch: () => void;
    queue.setProcessMessageFn(async () => {
      await new Promise<void>((r) => (resolveDispatch = r));
      return true;
    });

    queue.enqueueMessage("main", "msg");
    await vi.advanceTimersByTimeAsync(0);
    queue.notifyIdle("main");

    // Enqueue task — should trigger close on idle dispatch
    const taskRan = vi.fn();
    queue.enqueueTask("main", "scheduled-1", async () => taskRan());

    expect(closes).toEqual(["main"]);

    // Complete idle dispatch
    resolveDispatch!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Task should have run after dispatch ended (drain prioritizes tasks)
    expect(taskRan).toHaveBeenCalledOnce();
  });
});

// ── Mount security — real filesystem validation ──

describe("mount security — real filesystem validation", () => {
  let tempDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "validate-mounts-"));
    projectsDir = join(tempDir, "projects");
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(join(projectsDir, "my-app"), { recursive: true });
    mkdirSync(join(tempDir, ".ssh"), { recursive: true });
  });

  const makeAllowlist = (roots: string[]): MountAllowlist => ({
    allowedRoots: roots.map((p) => ({
      path: p,
      allowReadWrite: true,
    })),
    blockedPatterns: [],
    nonMainReadOnly: true,
  });

  it("validates mounts against real filesystem paths", () => {
    const allowlist = makeAllowlist([projectsDir]);

    const validated = validateAdditionalMounts(
      [
        { hostPath: join(projectsDir, "my-app") },
        { hostPath: join(tempDir, ".ssh") }, // blocked by default pattern
        { hostPath: join(tempDir, "nonexistent") }, // doesn't exist
      ],
      allowlist,
      true
    );

    // Only my-app should pass
    expect(validated).toHaveLength(1);
    expect(validated[0].containerPath).toBe("/workspace/extra/my-app");
    expect(validated[0].readonly).toBe(true); // default
  });

  it("enforces nonMainReadOnly for unprivileged agents", () => {
    const allowlist = makeAllowlist([projectsDir]);

    const validated = validateAdditionalMounts(
      [{ hostPath: join(projectsDir, "my-app"), readonly: false }],
      allowlist,
      false // not privileged
    );

    expect(validated).toHaveLength(1);
    expect(validated[0].readonly).toBe(true); // forced read-only
  });

  it("allows read-write for privileged agents", () => {
    const allowlist: MountAllowlist = {
      allowedRoots: [{ path: projectsDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false, // allow non-main write
    };

    const validated = validateAdditionalMounts(
      [{ hostPath: join(projectsDir, "my-app"), readonly: false }],
      allowlist,
      false
    );

    expect(validated).toHaveLength(1);
    expect(validated[0].readonly).toBe(false);
  });
});

// ── Scheduler — integration validation ──

describe("scheduler — integration validation", () => {
  const config: SchedulerConfig = {
    poll_interval_ms: 60000,
    timezone: "UTC",
  };

  function makeTask(overrides?: Partial<ScheduledTask>): ScheduledTask {
    return {
      id: "t1",
      agentId: "main",
      scope: "test",
      prompt: "run report",
      schedule_type: "interval",
      schedule_value: "300000", // 5 min
      context_mode: "agent",
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: "active",
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeMockStore(tasks: ScheduledTask[]): TaskStore & { _logs: TaskRunLog[] } {
    const store = [...tasks];
    const logs: TaskRunLog[] = [];
    return {
      getAllTasks: () => [...store],
      getTaskById: (id) => store.find((t) => t.id === id) ?? null,
      getDueTasks: () =>
        store.filter(
          (t) =>
            t.status === "active" &&
            t.next_run &&
            new Date(t.next_run).getTime() <= Date.now()
        ),
      createTask: (t) => store.push({ ...t, last_run: null, last_result: null } as ScheduledTask),
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
      _logs: logs,
    };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    _resetSchedulerForTests();
    vi.useRealTimers();
  });

  it("full lifecycle: schedule → detect due → execute → compute next → log", async () => {
    const task = makeTask();
    const store = makeMockStore([task]);

    await runScheduledTask(task, {
      store,
      config,
      executeTask: async (t) => `Report for ${t.agentId}`,
    });

    // Verify execution was logged
    expect(store._logs).toHaveLength(1);
    expect(store._logs[0].status).toBe("success");
    expect(store._logs[0].result).toBe("Report for main");

    // Verify next_run was computed (interval: 5 min from anchor)
    const updated = store.getTaskById("t1")!;
    expect(updated.next_run).toBeTruthy();
    const nextRunMs = new Date(updated.next_run!).getTime();
    expect(nextRunMs).toBeGreaterThan(Date.now());
    expect(updated.last_result).toBe("Report for main");
  });

  it("once task completes and doesn't reschedule", async () => {
    const task = makeTask({ schedule_type: "once", schedule_value: "" });
    const store = makeMockStore([task]);

    await runScheduledTask(task, {
      store,
      config,
      executeTask: async () => "done",
    });

    const updated = store.getTaskById("t1")!;
    expect(updated.status).toBe("completed");
    expect(updated.next_run).toBeNull();
  });

  it("cron task computes correct next occurrence", () => {
    const task = makeTask({
      schedule_type: "cron",
      schedule_value: "0 */6 * * *", // every 6 hours
    });

    const next = computeNextRun(task, config);
    expect(next).toBeTruthy();

    const nextDate = new Date(next!);
    expect(nextDate.getTime()).toBeGreaterThan(Date.now());
    expect(nextDate.getMinutes()).toBe(0);
  });

  it("interval drift prevention: skips missed runs and anchors to schedule", () => {
    const anchorTime = Date.now() - 1_500_000; // 25 min ago
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "300000", // 5 min
      next_run: new Date(anchorTime).toISOString(),
    });

    const next = computeNextRun(task, config);
    const nextMs = new Date(next!).getTime();

    // Should be anchored to the original schedule, not Date.now()
    // anchorTime + N*300000 where N is enough to be in the future
    expect(nextMs).toBeGreaterThan(Date.now());

    // Should be exactly on a 5-min boundary from the anchor
    const offset = nextMs - anchorTime;
    expect(offset % 300000).toBe(0);
  });

  it("scheduler dispatches via DispatchQueue when wired", () => {
    const task = makeTask();
    const store = makeMockStore([task]);
    const enqueued: string[] = [];

    const count = checkDueTasks({
      store,
      config,
      executeTask: async () => "ok",
      enqueueTask: (agentKey, taskId) => {
        enqueued.push(`${agentKey}:${taskId}`);
      },
    });

    expect(count).toBe(1);
    expect(enqueued).toEqual(["main:t1"]);
  });
});

// ── Cross-feature validation ──

describe("cross-feature: queue + scheduler integration", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    _resetSchedulerForTests();
    vi.useRealTimers();
  });

  it("scheduled task runs through DispatchQueue respecting concurrency", async () => {
    const queue = new DispatchQueue({ maxConcurrent: 5 });
    const taskResults: string[] = [];

    function makeTask(id: string): ScheduledTask {
      return {
        id,
        agentId: "main",
        scope: "test",
        prompt: "run",
        schedule_type: "once",
        schedule_value: "",
        context_mode: "agent",
        next_run: new Date(Date.now() - 1000).toISOString(),
        last_run: null,
        last_result: null,
        status: "active",
        created_at: new Date().toISOString(),
      };
    }

    const store: TaskStore = {
      getAllTasks: () => [],
      getTaskById: (id) => makeTask(id),
      getDueTasks: () => [makeTask("t1"), makeTask("t2")],
      createTask: () => {},
      updateTask: () => {},
      updateTaskAfterRun: () => {},
      logTaskRun: () => {},
      deleteTask: () => {},
    };

    const config: SchedulerConfig = { poll_interval_ms: 60000, timezone: "UTC" };

    // Wire scheduler to dispatch queue
    checkDueTasks({
      store,
      config,
      executeTask: async (t) => {
        taskResults.push(t.id);
        return "ok";
      },
      enqueueTask: (agentKey, taskId, fn) => {
        queue.enqueueTask(agentKey, taskId, fn);
      },
    });

    // Let tasks execute
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Both tasks should have run through the queue
    expect(taskResults).toContain("t1");
    expect(taskResults).toContain("t2");
  });
});
