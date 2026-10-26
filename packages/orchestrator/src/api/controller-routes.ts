/**
 * Controller API (D3b): loopback HTTP under /controller/ for the cc-controller daemon.
 *
 *   GET /controller/info          — {controller: {id, name, kind, capabilities}, person}
 *   GET /controller/sessions      — sessions listed for the token's person (ControllerSession[])
 *   GET /controller/sessions/:id  — one of them, 404 if not listed
 *   GET /controller/agents        — [{id, name}] the person may talk to
 *   GET /controller/sessions/:id/transcript?after=&limit=
 *                                 — the session's current transcript records, oldest first
 *                                   (raw when only the person is in it, else text-only)
 *   POST /controller/sessions/:id/message {text}
 *                                 — write as the person (403 read_only outside app:/peer:)
 *   POST /controller/sessions {agentId, text}
 *                                 — start a new app:<person>:<id> session, returns its row
 *   POST /controller/sessions/:id/sudo {task?}
 *                                 — /sudo: toggle the writable session's sudo mode, returns its row
 *   POST /controller/approvals/:id {behaviour: allow|deny}
 *                                 — decide an app:/peer: approval (403 read_only for one
 *                                   answered in Discord or the terminal)
 *   GET /controller/peer/sessions — D4: the person's sessions, for another controller's list
 *   POST /controller/peer/inbound {from, to, text, hops}
 *                                 — D4: a session on another controller messages one of them
 *                                   → {status: delivered|queued|awaiting_approval|refused, reason?}
 *   POST /controller/peer/start {from, agent?, text, hops}
 *                                 — D4: start a new peer: session for the person
 *                                   → {status: started|awaiting_approval|refused, ref?, label?}
 *   POST /controller/peer/notice {from, to, text, outcome?}
 *                                 — D4: the other controller's outcome for a message or start a
 *                                   session here sent (allowed|denied|undelivered)
 *                                   (`from.host` is a configured peers.remote host id; without
 *                                   peers.remote for the person, these are 404 unsupported)
 *   GET /controller/events        — SSE: `session` (a listed session's state changed),
 *                                   `transcript` (a new record, SSE id = record id),
 *                                   `approval` / `decision` (pending ones replayed on connect),
 *                                   plus a `ping` comment every 20 s
 *
 * Auth is a dedicated controller token per person (config `controller.tokens`), never
 * the root-equivalent dispatch token. Without configured tokens every route is 404.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ControllerError, type ControllerEvent, type ControllerService } from "../controller.js";

export const CONTROLLER_PING_MS = 20_000;

export interface ControllerRoutesOptions {
  /** token → that person's controller service. */
  services: Map<string, ControllerService>;
  /** This Stockade's controller identity, e.g. {id: "mustafar", name: "Mustafar"}. */
  controller: { id: string; name: string };
  /** D4: other controllers' requests through the daemon, for the token's person (null: not set up for them). */
  peerLink?: (person: string) => PeerLinkHandlers | null;
}

/** What /controller/peer/* calls for one person. */
export interface PeerLinkHandlers {
  sessions(): Promise<unknown>;
  inbound(body: Record<string, unknown>): Promise<unknown>;
  start(body: Record<string, unknown>): Promise<unknown>;
  notice(body: Record<string, unknown>): Promise<unknown>;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function mountControllerRoutes(app: Hono, options: ControllerRoutesOptions): void {
  // Compare fixed-length digests, so neither length nor content leaks through timing.
  const tokens = [...options.services].map(([token, service]) => ({ hash: digest(token), service }));

  const authorise = (c: Context): ControllerService | null => {
    const header = c.req.header("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return null;
    const got = digest(header.slice("Bearer ".length));
    let match: ControllerService | null = null;
    for (const entry of tokens) if (timingSafeEqual(got, entry.hash)) match = entry.service;
    return match;
  };

  app.use("/controller/*", async (c, next) => {
    if (tokens.length === 0) return c.json({ error: "not_found" }, 404);
    const service = authorise(c);
    if (!service) return c.json({ error: "unauthorized" }, 401);
    c.set("controller" as never, service as never);
    await next();
  });
  const serviceOf = (c: Context) => c.get("controller" as never) as unknown as ControllerService;

  app.get("/controller/info", (c) =>
    c.json({
      controller: { ...options.controller, kind: "stockade", capabilities: serviceOf(c).capabilities() },
      person: serviceOf(c).person,
    }));

  app.get("/controller/sessions", async (c) => c.json(await serviceOf(c).sessions()));

  app.get("/controller/sessions/:id", async (c) => {
    const session = await serviceOf(c).find(c.req.param("id"));
    return session ? c.json(session) : c.json({ error: "not_found" }, 404);
  });

  app.get("/controller/agents", (c) => c.json(serviceOf(c).agents()));

  /** Run a service call, turning a ControllerError into its status and `{error: code}`. */
  const answer = async (c: Context, run: () => Promise<unknown>) => {
    try {
      return c.json(await run() as object);
    } catch (err) {
      if (err instanceof ControllerError) return c.json({ error: err.code, message: err.message }, err.status);
      throw err;
    }
  };
  const jsonBody = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const value = await c.req.json();
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      throw new ControllerError(400, "invalid_json", "body must be a JSON object");
    }
  };

  app.get("/controller/sessions/:id/transcript", (c) =>
    answer(c, () => {
      const limit = c.req.query("limit");
      return serviceOf(c).transcript(c.req.param("id"), {
        after: c.req.query("after") || null,
        limit: limit === undefined ? null : Number(limit),
      });
    }));

  app.post("/controller/sessions/:id/message", (c) =>
    answer(c, async () => serviceOf(c).send(c.req.param("id"), (await jsonBody(c)).text)));

  app.post("/controller/sessions", (c) =>
    answer(c, async () => serviceOf(c).createSession(await jsonBody(c))));

  app.post("/controller/sessions/:id/sudo", (c) =>
    answer(c, async () => serviceOf(c).toggleSudo(c.req.param("id"), await jsonBody(c))));

  app.post("/controller/approvals/:id", (c) =>
    answer(c, async () => serviceOf(c).decide(c.req.param("id"), await jsonBody(c))));

  const linkOf = (c: Context) => options.peerLink?.(serviceOf(c).person) ?? null;
  const unsupported = (c: Context) => c.json({ error: "unsupported" }, 404);
  app.get("/controller/peer/sessions", async (c) => {
    const link = linkOf(c);
    return link ? c.json(await link.sessions() as object) : unsupported(c);
  });
  for (const op of ["inbound", "start", "notice"] as const) {
    app.post(`/controller/peer/${op}`, async (c) => {
      const link = linkOf(c);
      if (!link) return unsupported(c);
      return answer(c, async () => {
        const result = await link[op](await jsonBody(c)) as { status?: string; reason?: string };
        console.log(`[peers] remote ${op} for ${serviceOf(c).person}: ${result.status ?? "?"}${result.reason ? ` (${result.reason.slice(0, 80)})` : ""}`);
        return result;
      });
    });
  }

  app.get("/controller/events", (c) => {
    const service = serviceOf(c);
    return streamSSE(c, async (stream) => {
      let open = true;
      const send = (event: ControllerEvent) => {
        if (!open) return;
        const id = event.type === "transcript" ? event.recordId : undefined;
        stream.writeSSE({ event: event.type, data: JSON.stringify(event), ...(id ? { id } : {}) }).catch(() => {});
      };
      const unsubscribe = service.subscribe(send);
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      await stream.write(": connected\n\n");
      // The client doesn't list approvals: replay the waiting ones (a repeat is deduplicated by id).
      for (const event of await service.pendingApprovals()) send(event);
      while (open && !stream.aborted) {
        await stream.sleep(CONTROLLER_PING_MS);
        if (open && !stream.aborted) await stream.write(": ping\n\n");
      }
      unsubscribe();
    });
  });

  // Anything else under /controller/ is a route this Stockade doesn't offer (yet).
  app.all("/controller/*", (c) => c.json({ error: "unsupported" }, 404));
}
