import { z } from "zod";

// ── Scheduled task definition ──

export const scheduleTypeSchema = z.enum(["cron", "interval", "once"]);
export type ScheduleType = z.infer<typeof scheduleTypeSchema>;

export const taskStatusSchema = z.enum(["active", "paused", "completed"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const contextModeSchema = z.enum(["agent", "isolated"]);
export type ContextMode = z.infer<typeof contextModeSchema>;

export interface ScheduledTask {
  id: string;
  agentId: string;
  scope: string;
  prompt: string;
  script?: string | null;
  schedule_type: ScheduleType;
  schedule_value: string;
  context_mode: ContextMode;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: TaskStatus;
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: "success" | "error";
  result: string | null;
  error: string | null;
}

// ── Scheduler config ──

export const schedulerConfigSchema = z.object({
  /** Poll interval in ms. Default: 60000 (1 minute). */
  poll_interval_ms: z.number().default(60000),
  /** Timezone for cron expressions. Default: UTC. */
  timezone: z.string().default("UTC"),
});

export type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;

// ── Task store interface (abstraction over SQLite) ──

export interface TaskStore {
  getAllTasks(): ScheduledTask[];
  getTaskById(id: string): ScheduledTask | null;
  getDueTasks(): ScheduledTask[];
  createTask(task: Omit<ScheduledTask, "last_run" | "last_result">): void;
  updateTask(id: string, fields: Partial<ScheduledTask>): void;
  updateTaskAfterRun(
    id: string,
    nextRun: string | null,
    lastResult: string
  ): void;
  logTaskRun(log: TaskRunLog): void;
  deleteTask(id: string): void;
}
