import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SQLiteTaskStore, initSchedulerTables } from "../../src/scheduler/store.js";
import type { ScheduledTask } from "../../src/scheduler/types.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  initSchedulerTables(db);
  return db;
}

function makeTask(overrides?: Partial<ScheduledTask>): Omit<ScheduledTask, "last_run" | "last_result"> {
  return {
    id: "t1",
    agentId: "main",
    scope: "discord:server:channel",
    userId: "user123",
    userPlatform: "discord",
    prompt: "check the status",
    schedule_type: "interval",
    schedule_value: "3600000",
    context_mode: "isolated",
    next_run: new Date(Date.now() + 3600_000).toISOString(),
    status: "active",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("SQLiteTaskStore", () => {
  let store: SQLiteTaskStore;

  beforeEach(() => {
    store = new SQLiteTaskStore(makeDb());
  });

  it("createTask and getTaskById roundtrip", () => {
    store.createTask(makeTask());
    const t = store.getTaskById("t1");
    expect(t).not.toBeNull();
    expect(t!.id).toBe("t1");
    expect(t!.agentId).toBe("main");
    expect(t!.userId).toBe("user123");
    expect(t!.userPlatform).toBe("discord");
    expect(t!.prompt).toBe("check the status");
    expect(t!.context_mode).toBe("isolated");
    expect(t!.last_run).toBeNull();
    expect(t!.last_result).toBeNull();
  });

  it("getTaskById returns null for unknown id", () => {
    expect(store.getTaskById("nope")).toBeNull();
  });

  it("getAllTasks returns all stored tasks", () => {
    store.createTask(makeTask({ id: "t1" }));
    store.createTask(makeTask({ id: "t2" }));
    expect(store.getAllTasks()).toHaveLength(2);
  });

  it("getDueTasks only returns active tasks with next_run in the past", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();

    store.createTask(makeTask({ id: "due", next_run: past }));
    store.createTask(makeTask({ id: "future", next_run: future }));
    store.createTask(makeTask({ id: "paused", next_run: past, status: "paused" }));
    store.createTask(makeTask({ id: "no-next", next_run: null }));

    const due = store.getDueTasks();
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe("due");
  });

  it("updateTask mutates specified fields only", () => {
    store.createTask(makeTask());
    store.updateTask("t1", { status: "paused", prompt: "updated prompt" });
    const t = store.getTaskById("t1");
    expect(t!.status).toBe("paused");
    expect(t!.prompt).toBe("updated prompt");
    expect(t!.agentId).toBe("main"); // untouched
  });

  it("updateTaskAfterRun sets last_run and last_result", () => {
    store.createTask(makeTask());
    const nextRun = new Date(Date.now() + 3600_000).toISOString();
    store.updateTaskAfterRun("t1", nextRun, "all good");
    const t = store.getTaskById("t1");
    expect(t!.last_result).toBe("all good");
    expect(t!.last_run).not.toBeNull();
    expect(t!.next_run).toBe(nextRun);
    expect(t!.status).toBe("active"); // recurring task stays active
  });

  it("updateTaskAfterRun marks once tasks as completed when nextRun is null", () => {
    store.createTask(makeTask({ id: "t1", schedule_type: "once", schedule_value: new Date().toISOString() }));
    store.updateTaskAfterRun("t1", null, "done");
    const t = store.getTaskById("t1");
    expect(t!.status).toBe("completed");
    expect(t!.next_run).toBeNull();
  });

  it("completed tasks are not returned by getDueTasks", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    store.createTask(makeTask({ id: "t1", schedule_type: "once", schedule_value: past, next_run: past }));
    store.updateTaskAfterRun("t1", null, "done");
    expect(store.getDueTasks()).toHaveLength(0);
  });

  it("logTaskRun persists run records (smoke test)", () => {
    // No public reader for run logs, but inserting must not throw
    expect(() =>
      store.logTaskRun({
        task_id: "t1",
        run_at: new Date().toISOString(),
        duration_ms: 1500,
        status: "success",
        result: "ok",
        error: null,
      })
    ).not.toThrow();
  });

  it("deleteTask removes the task", () => {
    store.createTask(makeTask());
    store.deleteTask("t1");
    expect(store.getTaskById("t1")).toBeNull();
    expect(store.getAllTasks()).toHaveLength(0);
  });
});
