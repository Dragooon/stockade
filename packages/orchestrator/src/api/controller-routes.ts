/**
 * Controller API (D3b): loopback HTTP under /controller/ for the cc-controller daemon.
 *
 *   GET /controller/info          — {controller: {id, name, kind, capabilities}, person}
 *   GET /controller/sessions      — sessions listed for the token's person (ControllerSession[])
 *   GET /controller/sessions/:id  — one of them, 404 if not listed
 *   GET /controller/agents        — [{id, name}] the person may talk to
 *   GET /controller/events        — SSE: `session` (a listed session's state changed),
 *                                   plus a `ping` comment every 20 s
 *
 * Auth is a dedicated controller token per person (config `controller.tokens`), never
 * the root-equivalent dispatch token. Without configured tokens every route is 404.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { CONTROLLER_CAPABILITIES, type ControllerService } from "../controller.js";

export const CONTROLLER_PING_MS = 20_000;

export interface ControllerRoutesOptions {
  /** token → that person's controller service. */
  services: Map<string, ControllerService>;
  /** This Stockade's controller identity, e.g. {id: "mustafar", name: "Mustafar"}. */
  controller: { id: string; name: string };
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
      controller: { ...options.controller, kind: "stockade", capabilities: [...CONTROLLER_CAPABILITIES] },
      person: serviceOf(c).person,
    }));

  app.get("/controller/sessions", async (c) => c.json(await serviceOf(c).sessions()));

  app.get("/controller/sessions/:id", async (c) => {
    const session = await serviceOf(c).find(c.req.param("id"));
    return session ? c.json(session) : c.json({ error: "not_found" }, 404);
  });

  app.get("/controller/agents", (c) => c.json(serviceOf(c).agents()));

  app.get("/controller/events", (c) => {
    const service = serviceOf(c);
    return streamSSE(c, async (stream) => {
      let open = true;
      const unsubscribe = service.subscribe((event) => {
        if (!open) return;
        stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => {});
      });
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      await stream.write(": connected\n\n");
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
