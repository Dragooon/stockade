import type Database from "better-sqlite3";
import type { ScheduledTask, TaskRunLog, TaskStore } from "./types.js";

export function initSchedulerTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      scope         TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      user_platform TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      schedule_type  TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode  TEXT NOT NULL DEFAULT 'isolated',
      next_run      TEXT,
      last_run      TEXT,
      last_result   TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL,
      run_at      TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status      TEXT NOT NULL,
      result      TEXT,
      error       TEXT
    );
  `);
}

export class SQLiteTaskStore implements TaskStore {
  constructor(private readonly db: Database.Database) {}

  getAllTasks(): ScheduledTask[] {
    return (this.db.prepare("SELECT * FROM scheduled_tasks").all() as Row[]).map(rowToTask);
  }

  getTaskById(id: string): ScheduledTask | null {
    const row = this.db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToTask(row) : null;
  }

  getDueTasks(): ScheduledTask[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?"
        )
        .all(new Date().toISOString()) as Row[]
    ).map(rowToTask);
  }

  createTask(task: Omit<ScheduledTask, "last_run" | "last_result">): void {
    this.db
      .prepare(
        `INSERT INTO scheduled_tasks
           (id, agent_id, scope, user_id, user_platform, prompt,
            schedule_type, schedule_value, context_mode, next_run, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.agentId,
        task.scope,
        task.userId,
        task.userPlatform,
        task.prompt,
        task.schedule_type,
        task.schedule_value,
        task.context_mode,
        task.next_run,
        task.status,
        task.created_at
      );
  }

  updateTask(id: string, fields: Partial<ScheduledTask>): void {
    const COL: Record<string, string> = {
      agentId: "agent_id",
      scope: "scope",
      userId: "user_id",
      userPlatform: "user_platform",
      prompt: "prompt",
      schedule_type: "schedule_type",
      schedule_value: "schedule_value",
      context_mode: "context_mode",
      next_run: "next_run",
      last_run: "last_run",
      last_result: "last_result",
      status: "status",
    };

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, col] of Object.entries(COL)) {
      if (key in fields) {
        sets.push(`${col} = ?`);
        values.push((fields as Record<string, unknown>)[key]);
      }
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  updateTaskAfterRun(id: string, nextRun: string | null, lastResult: string): void {
    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET next_run    = ?,
             last_run    = ?,
             last_result = ?,
             status      = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
         WHERE id = ?`
      )
      .run(nextRun, new Date().toISOString(), lastResult, nextRun, id);
  }

  logTaskRun(log: TaskRunLog): void {
    this.db
      .prepare(
        `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(log.task_id, log.run_at, log.duration_ms, log.status, log.result ?? null, log.error ?? null);
  }

  deleteTask(id: string): void {
    this.db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
  }
}

// ── Internal ──

interface Row {
  id: string;
  agent_id: string;
  scope: string;
  user_id: string;
  user_platform: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  context_mode: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: string;
  created_at: string;
}

function rowToTask(row: Row): ScheduledTask {
  return {
    id: row.id,
    agentId: row.agent_id,
    scope: row.scope,
    userId: row.user_id,
    userPlatform: row.user_platform,
    prompt: row.prompt,
    schedule_type: row.schedule_type as ScheduledTask["schedule_type"],
    schedule_value: row.schedule_value,
    context_mode: row.context_mode as ScheduledTask["context_mode"],
    next_run: row.next_run,
    last_run: row.last_run,
    last_result: row.last_result,
    status: row.status as ScheduledTask["status"],
    created_at: row.created_at,
  };
}
