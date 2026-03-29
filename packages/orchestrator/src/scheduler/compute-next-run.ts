import { CronExpressionParser } from "cron-parser";
import type { ScheduledTask, SchedulerConfig } from "./types.js";

/**
 * Compute the next run time for a recurring task.
 *
 * Interval tasks are anchored to the scheduled time (next_run) rather than
 * Date.now() to prevent cumulative drift. If the anchor is in the past
 * (e.g. the process was down), we skip past any missed intervals.
 *
 * Borrowed from NanoClaw's computeNextRun pattern.
 */
export function computeNextRun(
  task: ScheduledTask,
  config: SchedulerConfig,
  now: number = Date.now()
): string | null {
  if (task.schedule_type === "once") return null;

  if (task.schedule_type === "cron") {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: config.timezone,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === "interval") {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval — default to 1 minute
      return new Date(now + 60_000).toISOString();
    }

    // Anchor to scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}
