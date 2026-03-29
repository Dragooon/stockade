import { randomBytes } from "node:crypto";
import type { RefToken } from "../shared/types.js";

const refs = new Map<string, RefToken>();

/**
 * Issue a credential reference token.
 * The ref is an opaque string the agent can place in request bodies.
 * The proxy will substitute it with the real credential value on the wire.
 */
export function issueRef(
  gatewayToken: string,
  credentialKey: string,
  ttlMs: number,
): RefToken {
  const nonce = randomBytes(16).toString("hex");
  const ref = `apw-ref:${credentialKey}:${nonce}`;
  const entry: RefToken = {
    ref,
    credentialKey,
    gatewayToken,
    expiresAt: Date.now() + ttlMs,
    consumed: false,
  };
  refs.set(ref, entry);
  return entry;
}

/**
 * Consume a reference token (one-time use).
 * Returns the RefToken if valid, or null if unknown / expired / already consumed.
 */
export function consumeRef(ref: string): RefToken | null {
  const entry = refs.get(ref);
  if (!entry) return null;
  if (entry.consumed || entry.expiresAt <= Date.now()) {
    refs.delete(ref);
    return null;
  }
  entry.consumed = true;
  return entry;
}

/**
 * Sweep expired and consumed refs to prevent unbounded memory growth.
 * Returns the number of entries removed.
 */
export function sweepRefs(): number {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of refs) {
    if (entry.consumed || entry.expiresAt <= now) {
      refs.delete(key);
      removed++;
    }
  }
  return removed;
}

/**
 * Start a periodic sweep interval. Returns the timer handle for cleanup.
 */
export function startRefSweep(intervalMs = 60_000): ReturnType<typeof setInterval> {
  return setInterval(sweepRefs, intervalMs);
}

/** Visible for testing — clear all refs. */
export function clearAllRefs(): void {
  refs.clear();
}

/** Visible for testing — current store size. */
export function refCount(): number {
  return refs.size;
}
