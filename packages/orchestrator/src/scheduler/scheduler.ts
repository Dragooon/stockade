import { computeNextRun } from "./compute-next-run.js";
import type {
  ScheduledTask,
  SchedulerConfig,
  TaskStore,
  TaskRunLog,
} from "./types.js";

export interface SchedulerDependencies {
  store: TaskStore;
  config: SchedulerConfig;
  /**
   * Execute a scheduled task. Called by the scheduler when a task is due.
   * Should return the result text or throw on failure.
   */
  executeTask: (task: ScheduledTask) => Promise<string>;
  /**
   * Enqueue a task for dispatch via the DispatchQueue.
   * This respects per-agent serialization and concurrency limits.
   */
  enqueueTask?: (
    agentKey: string,
    taskId: string,
    fn: () => Promise<void>
  ) => void;
}

let schedulerRunning = false;
let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Run a single scheduled task: execute, log result, compute next run.
 */
export async function runScheduledTask(
  task: ScheduledTask,
  deps: SchedulerDependencies
): Promise<void> {
  const startTime = Date.now();
  let result: string | null = null;
  let error: string | null = null;

  try {
    result = await deps.executeTask(task);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startTime;

  // Log the run
  deps.store.logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? "error" : "success",
    result,
    error,
  });

  // Compute next run and update task
  const nextRun = computeNextRun(task, deps.config);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : "Completed";

  deps.store.updateTaskAfterRun(task.id, nextRun, resultSummary);
}

/**
 * Check for due tasks and dispatch them.
 * Returns the number of tasks dispatched.
 */
export function checkDueTasks(deps: SchedulerDependencies): number {
  const dueTasks = deps.store.getDueTasks();
  let dispatched = 0;

  for (const task of dueTasks) {
    // Re-check task status in case it was paused/cancelled concurrently
    const current = deps.store.getTaskById(task.id);
    if (!current || current.status !== "active") continue;

    if (deps.enqueueTask) {
      // Dispatch via queue (respects concurrency + per-agent serialization)
      deps.enqueueTask(current.agentId, current.id, () =>
        runScheduledTask(current, deps)
      );
    } else {
      // Direct execution (no queue — for testing or simple setups)
      runScheduledTask(current, deps).catch(() => {});
    }

    dispatched++;
  }

  return dispatched;
}

/**
 * Start the scheduler poll loop.
 * Idempotent — calling multiple times is safe (second call is a no-op).
 */
export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) return;
  schedulerRunning = true;

  const loop = () => {
    try {
      checkDueTasks(deps);
    } catch {
      // Swallow errors to keep the loop alive
    }

    schedulerTimer = setTimeout(loop, deps.config.poll_interval_ms);
  };

  loop();
}

/**
 * Stop the scheduler loop.
 */
export function stopSchedulerLoop(): void {
  schedulerRunning = false;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

/** @internal — for tests only */
export function _resetSchedulerForTests(): void {
  schedulerRunning = false;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}
