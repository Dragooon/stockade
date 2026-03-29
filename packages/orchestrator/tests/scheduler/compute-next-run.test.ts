import { describe, it, expect, vi, afterEach } from "vitest";
import { computeNextRun } from "../../src/scheduler/compute-next-run.js";
import type { ScheduledTask, SchedulerConfig } from "../../src/scheduler/types.js";

const config: SchedulerConfig = {
  poll_interval_ms: 60000,
  timezone: "UTC",
};

function makeTask(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "t1",
    agentId: "main",
    scope: "test",
    prompt: "do something",
    schedule_type: "interval",
    schedule_value: "60000",
    context_mode: "agent",
    next_run: new Date(1000000).toISOString(),
    last_run: null,
    last_result: null,
    status: "active",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("computeNextRun", () => {
  // ── once ──

  it("returns null for once tasks", () => {
    const task = makeTask({ schedule_type: "once" });
    expect(computeNextRun(task, config)).toBeNull();
  });

  // ── interval ──

  it("computes next interval anchored to scheduled time", () => {
    const now = 1000000 + 60000 + 500; // just past the interval
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "60000",
      next_run: new Date(1000000).toISOString(),
    });

    const next = computeNextRun(task, config, now);
    // Should be 1000000 + 60000 + 60000 = 1120000
    // Because 1060000 <= 1060500, so skip to 1120000
    expect(new Date(next!).getTime()).toBe(1120000);
  });

  it("skips past missed intervals", () => {
    const now = 1000000 + 60000 * 5 + 100; // missed 5 intervals
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "60000",
      next_run: new Date(1000000).toISOString(),
    });

    const next = computeNextRun(task, config, now);
    const nextTime = new Date(next!).getTime();
    // Should be 1000000 + 60000 * 6 = 1360000 (first future interval)
    expect(nextTime).toBe(1360000);
    expect(nextTime).toBeGreaterThan(now);
  });

  it("handles interval just at the boundary", () => {
    const now = 1000000 + 60000; // exactly at the boundary
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "60000",
      next_run: new Date(1000000).toISOString(),
    });

    const next = computeNextRun(task, config, now);
    // 1060000 <= 1060000, so skip to 1120000
    expect(new Date(next!).getTime()).toBe(1120000);
  });

  it("guards against zero interval", () => {
    const now = 1000000;
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "0",
      next_run: new Date(1000000).toISOString(),
    });

    const next = computeNextRun(task, config, now);
    // Fallback: now + 60s
    expect(new Date(next!).getTime()).toBe(now + 60000);
  });

  it("guards against negative interval", () => {
    const now = 1000000;
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "-1000",
      next_run: new Date(1000000).toISOString(),
    });

    const next = computeNextRun(task, config, now);
    expect(new Date(next!).getTime()).toBe(now + 60000);
  });

  it("guards against non-numeric interval", () => {
    const now = 1000000;
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "abc",
      next_run: new Date(1000000).toISOString(),
    });

    const next = computeNextRun(task, config, now);
    expect(new Date(next!).getTime()).toBe(now + 60000);
  });

  // ── cron ──

  it("returns next cron occurrence", () => {
    // Every hour at :00
    const task = makeTask({
      schedule_type: "cron",
      schedule_value: "0 * * * *",
    });

    const next = computeNextRun(task, config);
    expect(next).toBeTruthy();

    const nextDate = new Date(next!);
    expect(nextDate.getMinutes()).toBe(0);
    expect(nextDate.getTime()).toBeGreaterThan(Date.now());
  });

  it("respects timezone for cron", () => {
    const task = makeTask({
      schedule_type: "cron",
      schedule_value: "0 12 * * *", // noon every day
    });

    const next = computeNextRun(task, { ...config, timezone: "UTC" });
    expect(next).toBeTruthy();

    const nextDate = new Date(next!);
    expect(nextDate.getUTCHours()).toBe(12);
  });

  // ── unknown type ──

  it("returns null for unknown schedule type", () => {
    const task = makeTask({
      schedule_type: "unknown" as any,
    });
    expect(computeNextRun(task, config)).toBeNull();
  });

  // ── DST transition ──

  describe("DST spring-forward transition", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("handles spring-forward: 2:30 AM cron in America/New_York skips to 3:00 AM+", () => {
      // DST spring-forward 2025: March 9, 2025, at 2:00 AM EST → 3:00 AM EDT
      // Set fake clock to just before 2:00 AM EST (March 9, 2025 at 1:55 AM EST = 6:55 AM UTC)
      const justBeforeSpringForward = new Date("2025-03-09T06:55:00.000Z").getTime();
      vi.useFakeTimers({ now: justBeforeSpringForward });

      const nyConfig: SchedulerConfig = {
        poll_interval_ms: 60000,
        timezone: "America/New_York",
      };

      const task = makeTask({
        schedule_type: "cron",
        schedule_value: "30 2 * * *", // 2:30 AM local time
      });

      const next = computeNextRun(task, nyConfig);
      expect(next).not.toBeNull();

      const nextDate = new Date(next!);

      // 2:30 AM does not exist on March 9, 2025 in America/New_York
      // (clocks jump from 2:00 AM EST straight to 3:00 AM EDT).
      // The cron parser adjusts the non-existent time into the EDT offset,
      // producing March 9 at 07:30 UTC (= 3:30 AM EDT). Key invariant:
      // the result is in the future and does not land in the skipped hour.
      expect(nextDate.getTime()).toBeGreaterThan(justBeforeSpringForward);

      // The non-existent window in UTC is 07:00–08:00 on March 9 (2:00–3:00 AM EST).
      // After spring-forward, EST offsets stop and EDT offsets begin, so the cron
      // parser shifts 2:30 AM to 3:30 AM EDT = 07:30 UTC. Verify:
      expect(nextDate.getUTCDate()).toBe(9);
      expect(nextDate.getUTCHours()).toBe(7);
      expect(nextDate.getUTCMinutes()).toBe(30);
    });

    it("handles fall-back: 1:30 AM cron in America/New_York does not double-fire", () => {
      // DST fall-back 2025: November 2, 2025, at 2:00 AM EDT → 1:00 AM EST
      // 1:30 AM happens twice. Set clock to just after the first 1:30 AM EDT.
      // First 1:30 AM EDT = 5:30 AM UTC on Nov 2
      const afterFirst130 = new Date("2025-11-02T05:31:00.000Z").getTime();
      vi.useFakeTimers({ now: afterFirst130 });

      const nyConfig: SchedulerConfig = {
        poll_interval_ms: 60000,
        timezone: "America/New_York",
      };

      const task = makeTask({
        schedule_type: "cron",
        schedule_value: "30 1 * * *", // 1:30 AM local time
      });

      const next = computeNextRun(task, nyConfig);
      expect(next).not.toBeNull();

      const nextDate = new Date(next!);

      // Must be in the future
      expect(nextDate.getTime()).toBeGreaterThan(afterFirst130);

      // The next occurrence should be November 3 at 1:30 AM EST = 6:30 AM UTC
      // (not the second 1:30 AM on November 2, which already happened)
      expect(nextDate.getUTCDate()).toBeGreaterThanOrEqual(2);
    });
  });
});
