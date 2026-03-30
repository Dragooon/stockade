import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ProxyConfig, GatewayToken } from "../shared/types.js";
import { resolveCredential, storeCredential, invalidateCache } from "../shared/credentials.js";
import {
  issueToken,
  validateToken,
  checkCredentialScope,
  checkStoreScope,
  revokeToken,
} from "./tokens.js";
import { issueRef, startRefSweep } from "./refs.js";

type AppEnv = {
  Variables: {
    tokenData: Omit<GatewayToken, "token">;
    rawToken: string;
  };
};

/**
 * Start the gateway API server.
 * Provides credential storage (apw store) and token management.
 *
 * Accepts a config getter for hot-reloading provider and gateway settings.
 * Listen address/port use the initial config (changing requires restart).
 */
export function startGateway(getConfig: () => ProxyConfig) {
  const app = new Hono<AppEnv>();

  // ── Auth middleware ─────────────────────────────────────────
  app.use("/gateway/*", async (c, next) => {
    const authHeader = c.req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid authorization" }, 401);
    }
    const token = authHeader.slice(7);
    const tokenData = validateToken(token);
    if (!tokenData) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    // Attach token data to context
    c.set("tokenData", tokenData);
    c.set("rawToken", token);
    await next();
  });

  // ── GET /gateway/ref/* — Issue a credential reference token ──
  // Returns an opaque ref string the agent can place in request bodies.
  // The proxy substitutes it with the real credential on the wire.
  app.get("/gateway/ref/*", async (c) => {
    const key = new URL(c.req.url).pathname.replace(/^\/gateway\/ref\//, "");
    const rawToken = c.get("rawToken") as string;

    if (!checkCredentialScope(rawToken, key)) {
      console.log(`[gateway] ref denied: key="${key}"`);
      return c.json({ error: "Credential scope denied for this key" }, 403);
    }

    const ttlMs = getConfig().gateway.ref_ttl * 1000;
    const ref = issueRef(rawToken, key, ttlMs);
    console.log(`[gateway] issued ref for key="${key}"`);
    return c.json({ ref: ref.ref, expiresAt: ref.expiresAt });
  });

  // ── GET /gateway/reveal/* — Reveal a credential's raw value ──
  // Returns the plaintext credential. Intended for scenarios where the agent
  // needs the actual value (e.g. filling a browser form). This command should
  // be gated by "ask" permission in the agent's permission rules.
  app.get("/gateway/reveal/*", async (c) => {
    const key = new URL(c.req.url).pathname.replace(/^\/gateway\/reveal\//, "");
    const rawToken = c.get("rawToken") as string;

    if (!checkCredentialScope(rawToken, key)) {
      console.log(`[gateway] reveal denied: key="${key}"`);
      return c.json({ error: "Credential scope denied for this key" }, 403);
    }

    try {
      const value = await resolveCredential(getConfig().provider, key);
      console.log(`[gateway] revealed credential: key="${key}"`);
      return c.json({ key, value });
    } catch (err: any) {
      console.error(`[gateway] reveal failed: key="${key}"`, err.message);
      return c.json({ error: `Failed to resolve credential: ${err.message}` }, 500);
    }
  });

  // ── POST /gateway/store/* — Store a credential ──────────
  // Key is a multi-segment path (e.g., AgentVault/GitHub/token)
  app.post("/gateway/store/*", async (c) => {
    const key = new URL(c.req.url).pathname.replace(/^\/gateway\/store\//, "");
    const rawToken = c.get("rawToken") as string;

    // Check store scope
    if (!checkStoreScope(rawToken, key)) {
      console.log(`[gateway] store denied: key="${key}"`);
      return c.json({ error: "Store scope denied for this key" }, 403);
    }

    const body = await c.req.json<{
      value: string;
      route?: {
        host: string;
        header: string;
        format?: string;
      };
    }>();

    if (!body.value) {
      return c.json({ error: "Missing value" }, 400);
    }

    // Write to provider
    await storeCredential(getConfig().provider, key, body.value);
    console.log(`[gateway] stored credential: ${key}`);

    // If route metadata provided, log it (actual config update is a future enhancement)
    if (body.route) {
      console.log(
        `[gateway] route metadata for ${key}: host=${body.route.host}, header=${body.route.header}`
      );
    }

    return c.json({ ok: true, key });
  });

  // ── POST /gateway/token — Issue a new token (orchestrator use) ──
  // This endpoint is NOT behind the bearer middleware — it uses a
  // separate orchestrator secret. For now, we keep it simple.
  app.post("/token", async (c) => {
    const body = await c.req.json<{
      agentId: string;
      credentials: string[];
      storeKeys?: string[];
    }>();

    if (!body.agentId) {
      return c.json({ error: "Missing agentId" }, 400);
    }

    const token = issueToken(
      body.agentId,
      body.credentials ?? [],
      body.storeKeys,
      getConfig().gateway.token_ttl
    );

    console.log(`[gateway] issued token for agent "${body.agentId}"`);
    return c.json({ token: token.token, expiresAt: token.expiresAt });
  });

  // ── DELETE /gateway/token/:token — Revoke a token ──────────
  app.delete("/token/:token", async (c) => {
    const token = c.req.param("token");
    revokeToken(token);
    console.log(`[gateway] revoked token`);
    return c.json({ ok: true });
  });

  // ── POST /gateway/cache/invalidate — Clear credential cache ──
  app.post("/gateway/cache/invalidate", async (c) => {
    const body = await c.req.json<{ key?: string }>().catch(() => ({}));
    invalidateCache((body as any)?.key);
    return c.json({ ok: true });
  });

  const initialConfig = getConfig();
  const host = initialConfig.host ?? "127.0.0.1";
  const server = serve({
    fetch: app.fetch,
    hostname: host,
    port: initialConfig.gateway.port,
  });

  // Sweep expired/consumed ref tokens every 60s
  const sweepHandle = startRefSweep(60_000);
  server.on("close", () => clearInterval(sweepHandle));

  console.log(`[gateway] listening on ${host}:${initialConfig.gateway.port}`);
  return server;
}
