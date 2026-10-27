/**
 * Which scopes have a turn running, for scripts on this host (a deploy runner waits until none
 * do before it stops Stockade, so a restart never cuts someone's turn). Same token as /dispatch.
 *
 *   GET /dispatch/busy → { busy: string[] }   (scopes with a dispatch in flight, sorted)
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";

export interface BusyRoutesOptions {
  /** STOCKADE_API_TOKEN; the route answers 401 to everyone without one. */
  apiToken: string | undefined;
  /** Scopes with a turn running right now (bridge.busyScopes()); null before the Redis bridge is up. */
  busyScopes: (() => string[]) | null;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function mountBusyRoutes(app: Hono, options: BusyRoutesOptions): void {
  app.get("/dispatch/busy", (c) => {
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    // Compare fixed-length digests, so neither length nor content leaks through timing.
    const authorized = !!options.apiToken && timingSafeEqual(digest(presented), digest(options.apiToken));
    if (!authorized) return c.json({ error: "unauthorized" }, 401);
    if (!options.busyScopes) return c.json({ error: "Redis bridge not initialized" }, 503);
    const busy = [...options.busyScopes()].sort();
    return c.json({ busy });
  });
}
