/**
 * Peers over HTTP for principals (D3b §10): an agent outside Stockade, such as Kepler, holds
 * its own token and acts only as its own RBAC user. The routes mirror the peers tools and
 * answer with the same text; what's sent to the principal waits in its inbox.
 *
 *   POST /peers/list                      → { ok, text }
 *   POST /peers/send   { to, message }    → { ok, text }   (a new pairing answers "held: …")
 *   POST /peers/start  { message, agent?, host? } → { ok, text }
 *   POST /peers/inbox  { max? }           → { items: PeerInboxItem[] } (removed as returned)
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import type { PeerCaller, PeerService } from "../peers.js";

export interface PeerPrincipalRoutesOptions {
  /** token → the principal's caller (scope `principal:<name>`, its RBAC identity, the principal). */
  callers: Map<string, PeerCaller>;
  peers: PeerService;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function mountPeerPrincipalRoutes(app: Hono, options: PeerPrincipalRoutesOptions): void {
  // Compare fixed-length digests, so neither length nor content leaks through timing.
  const tokens = [...options.callers].map(([token, caller]) => ({ hash: digest(token), caller }));

  app.use("/peers/*", async (c, next) => {
    if (tokens.length === 0) return c.json({ error: "not_found" }, 404);
    const header = c.req.header("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return c.json({ error: "unauthorized" }, 401);
    const got = digest(header.slice("Bearer ".length));
    let match: PeerCaller | null = null;
    for (const entry of tokens) if (timingSafeEqual(got, entry.hash)) match = entry.caller;
    if (!match) return c.json({ error: "unauthorized" }, 401);
    c.set("peerCaller" as never, match as never);
    await next();
  });
  const callerOf = (c: Context) => c.get("peerCaller" as never) as unknown as PeerCaller;
  const body = async (c: Context) => {
    const parsed = await c.req.json().catch(() => ({}));
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  };
  const answer = (c: Context, op: string, text: string) => {
    console.log(`[peers] ${op} from ${callerOf(c).principal?.name ?? "?"}: ${text.split("\n")[0].slice(0, 100)}`);
    return c.json({ ok: !text.startsWith("Error:"), text });
  };

  app.post("/peers/list", async (c) => answer(c, "list", await options.peers.listTool(callerOf(c))));
  app.post("/peers/send", async (c) => {
    const args = await body(c);
    return answer(c, "send", await options.peers.sendTool(callerOf(c), args.to, args.message));
  });
  app.post("/peers/start", async (c) => {
    const args = await body(c);
    return answer(c, "start", await options.peers.startTool(callerOf(c), args.host, args.agent, args.message));
  });
  app.post("/peers/inbox", async (c) => {
    const args = await body(c);
    const max = typeof args.max === "number" && Number.isInteger(args.max) && args.max > 0 ? Math.min(args.max, 200) : 50;
    return c.json({ items: options.peers.drainInbox(callerOf(c).principal!.name, max) });
  });
  app.all("/peers/*", (c) => c.json({ error: "unsupported" }, 404));
}
