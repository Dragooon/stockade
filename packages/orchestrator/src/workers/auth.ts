import { randomBytes } from "node:crypto";

/**
 * Shared secret for orchestrator → worker HTTP calls, fresh per orchestrator
 * process. Host workers get it as WORKER_AUTH_TOKEN and reject /sessions*
 * requests without it, so other local users can't drive a worker.
 * Container workers don't get it and don't check (Docker networking is their boundary).
 */
export const WORKER_AUTH_TOKEN = randomBytes(32).toString("hex");

export function workerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${WORKER_AUTH_TOKEN}`, ...extra };
}
