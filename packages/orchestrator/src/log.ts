/**
 * Shared log utilities for the orchestrator and its managed workers.
 *
 * - appendLog: timestamped file append with 10MB size-based rotation
 * - createWorkerLogger: per-agent log writer under <logsDir>/workers/<agentId>.log
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Append a timestamped line to a log file.
 * Rotates to <file>.1 (dropping any prior .1) when the file exceeds 10MB.
 */
export function appendLog(file: string, message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    try {
      if (statSync(file).size > MAX_LOG_SIZE) {
        const rotated = `${file}.1`;
        try { unlinkSync(rotated); } catch { /* no prior rotation */ }
        renameSync(file, rotated);
      }
    } catch { /* file doesn't exist yet */ }
    appendFileSync(file, line);
  } catch { /* best-effort */ }
}

/**
 * Create a log writer that appends to <logsDir>/workers/<agentId>.log.
 * Creates the directory on first call.
 */
export function createWorkerLogger(logsDir: string, agentId: string): (message: string) => void {
  const file = join(logsDir, "workers", `${agentId}.log`);
  mkdirSync(dirname(file), { recursive: true });
  return (message: string) => appendLog(file, message);
}
