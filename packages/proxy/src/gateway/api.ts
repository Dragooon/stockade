import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ProxyConfig, GatewayToken } from "../shared/types.js";
import { storeCredential, invalidateCache } from "../shared/credentials.js";
import {
  issueToken,
  validateToken,
  checkStoreScope,
  revokeToken,
} from "./tokens.js";

type AppEnv = {
  Variables: {
    tokenData: Omit<GatewayToken, "token">;
    rawToken: string;
  };
};

/**
 * Start the gateway API server.
 * Provides credential storage (apw store) and token management.
 */
export function startGateway(config: ProxyConfig) {
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
    await storeCredential(config.provider, key, body.value);
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
      config.gateway.token_ttl
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

  const host = config.host ?? "127.0.0.1";
  const server = serve({
    fetch: app.fetch,
    hostname: host,
    port: config.gateway.port,
  });

  console.log(`[gateway] listening on ${host}:${config.gateway.port}`);
  return server;
}
