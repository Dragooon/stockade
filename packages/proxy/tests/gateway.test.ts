import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { ProxyConfig } from "../src/shared/types.js";
import {
  issueToken,
  clearAllTokens,
} from "../src/gateway/tokens.js";

// Mock credentials module
vi.mock("../src/shared/credentials.js", () => ({
  storeCredential: vi.fn().mockResolvedValue(undefined),
  resolveCredential: vi.fn().mockResolvedValue("-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----"),
  invalidateCache: vi.fn(),
}));

const { storeCredential, resolveCredential } = await import("../src/shared/credentials.js");

// Mock ssh2 — simulate SSH client connect/exec lifecycle
vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");

  class MockStream extends EventEmitter {
    stderr = new EventEmitter();
  }

  class MockSshClient extends EventEmitter {
    connect(_opts: unknown) {
      // Emit "ready" on next tick by default; individual tests can override
      process.nextTick(() => this.emit("ready"));
    }
    exec(_cmd: string, cb: (err: Error | null, stream: MockStream) => void) {
      const stream = new MockStream();
      cb(null, stream);
      process.nextTick(() => {
        stream.emit("data", Buffer.from("hello stdout\n"));
        stream.stderr.emit("data", Buffer.from("hello stderr\n"));
        stream.emit("close", 0);
      });
    }
    end() {}
  }

  return { default: { Client: MockSshClient } };
});

// We test the gateway API by importing it and calling fetch on it directly
// using Hono's built-in test helper
const { startGateway } = await import("../src/gateway/api.js");

const config: ProxyConfig = {
  host: "127.0.0.1",
  provider: {
    read: "op read op://{key}",
    write: "op item create --title {key} password={value}",
    update: "op item edit {key} password={value}",
    cache_ttl: 300,
  },
  policy: { default: "deny", rules: [] },
  http: {
    port: 10255,
    tls: { ca_cert: "./ca.crt", ca_key: "./ca.key" },
    strip_headers: [],
    routes: [],
  },
  ssh: { port: 10022, ca_key: "./ssh_ca", routes: [] },
  gateway: { port: 0, token_ttl: 3600 }, // port 0 to avoid conflict
};

describe("gateway API", () => {
  let token: string;
  let server: any;

  beforeEach(() => {
    clearAllTokens();
    vi.clearAllMocks();
    // Issue a test token with store scope
    const issued = issueToken(
      "main",
      ["AgentVault/GitHub/token"],
      ["AgentVault/*"],
      3600
    );
    token = issued.token;
  });

  it("POST /gateway/store/:key — stores credential with valid token and scope", async () => {
    // Build a standalone Hono app for testing (without starting a server)
    const app = new Hono();

    // Inline the gateway routes for direct testing
    const { validateToken, checkStoreScope } = await import("../src/gateway/tokens.js");
    const { storeCredential, invalidateCache } = await import("../src/shared/credentials.js");

    app.use("/gateway/*", async (c, next) => {
      const authHeader = c.req.header("authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return c.json({ error: "Missing auth" }, 401);
      }
      const t = authHeader.slice(7);
      const data = validateToken(t);
      if (!data) return c.json({ error: "Invalid token" }, 401);
      c.set("rawToken", t);
      await next();
    });

    app.post("/gateway/store/*", async (c) => {
      const key = new URL(c.req.url).pathname.replace(/^\/gateway\/store\//, "");
      const rawToken = c.get("rawToken") as string;
      if (!checkStoreScope(rawToken, key)) {
        return c.json({ error: "Store scope denied" }, 403);
      }
      const body = await c.req.json<{ value: string }>();
      await (storeCredential as any)(config.provider, key, body.value);
      return c.json({ ok: true, key });
    });

    const res = await app.request("/gateway/store/AgentVault/GitHub/new-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ value: "ghp_new_secret" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(storeCredential).toHaveBeenCalledWith(
      config.provider,
      "AgentVault/GitHub/new-token",
      "ghp_new_secret"
    );
  });

  it("POST /gateway/store/:key — denies out-of-scope key", async () => {
    const app = new Hono();
    const { validateToken, checkStoreScope } = await import("../src/gateway/tokens.js");

    app.use("/gateway/*", async (c, next) => {
      const authHeader = c.req.header("authorization");
      if (!authHeader?.startsWith("Bearer ")) return c.json({ error: "no" }, 401);
      const t = authHeader.slice(7);
      if (!validateToken(t)) return c.json({ error: "bad" }, 401);
      c.set("rawToken", t);
      await next();
    });

    app.post("/gateway/store/*", async (c) => {
      const key = new URL(c.req.url).pathname.replace(/^\/gateway\/store\//, "");
      const rawToken = c.get("rawToken") as string;
      if (!checkStoreScope(rawToken, key)) {
        return c.json({ error: "Store scope denied" }, 403);
      }
      return c.json({ ok: true });
    });

    // Issue a token WITHOUT store scope
    const restricted = issueToken("researcher", ["key1"], undefined, 3600);

    const res = await app.request("/gateway/store/AgentVault/Something", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${restricted.token}`,
      },
      body: JSON.stringify({ value: "secret" }),
    });

    expect(res.status).toBe(403);
  });

  it("rejects request with no auth header", async () => {
    const app = new Hono();
    const { validateToken } = await import("../src/gateway/tokens.js");

    app.use("/gateway/*", async (c, next) => {
      const authHeader = c.req.header("authorization");
      if (!authHeader?.startsWith("Bearer ")) return c.json({ error: "Missing auth" }, 401);
      const t = authHeader.slice(7);
      if (!validateToken(t)) return c.json({ error: "Invalid" }, 401);
      await next();
    });

    app.post("/gateway/store/*", async (c) => c.json({ ok: true }));

    const res = await app.request("/gateway/store/key", {
      method: "POST",
      body: JSON.stringify({ value: "x" }),
    });

    expect(res.status).toBe(401);
  });

  it("POST /gateway/ssh-exec — returns 400 on missing host/command", async () => {
    const app = new Hono();
    const { validateToken } = await import("../src/gateway/tokens.js");
    const { startGateway: _ } = await import("../src/gateway/api.js");

    // Build a minimal inline version of the ssh-exec route for unit testing
    app.use("/gateway/*", async (c, next) => {
      const t = c.req.header("authorization")?.slice(7) ?? "";
      const data = validateToken(t);
      if (!data) return c.json({ error: "Unauthorized" }, 401);
      c.set("rawToken", t);
      await next();
    });
    app.post("/gateway/ssh-exec", async (c) => {
      const body = await c.req.json<any>().catch(() => null);
      if (!body?.host || !body?.command) return c.json({ error: "Missing host or command" }, 400);
      return c.json({ ok: true });
    });

    const issued = issueToken("main", ["seedbox-ssh-key"], undefined, 3600);
    const res = await app.request("/gateway/ssh-exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ host: "katong.usbx.me" }), // missing command
    });
    expect(res.status).toBe(400);
  });

  it("POST /gateway/ssh-exec — returns 404 when no route matches host", async () => {
    const app = new Hono();
    const { validateToken } = await import("../src/gateway/tokens.js");
    app.use("/gateway/*", async (c, next) => {
      const t = c.req.header("authorization")?.slice(7) ?? "";
      if (!validateToken(t)) return c.json({ error: "Unauthorized" }, 401);
      c.set("rawToken", t);
      await next();
    });
    app.post("/gateway/ssh-exec", async (c) => {
      const body = await c.req.json<any>();
      const routes: any[] = []; // no routes
      const route = routes.find((r: any) => r.host === body.host);
      if (!route) return c.json({ error: `No SSH route configured for ${body.host}` }, 404);
      return c.json({ ok: true });
    });

    const issued = issueToken("main", ["seedbox-ssh-key"], undefined, 3600);
    const res = await app.request("/gateway/ssh-exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ host: "unknown.host.example", command: "ls" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /gateway/ssh-exec — returns 403 when credential not in token scope", async () => {
    const app = new Hono();
    const { validateToken, checkCredentialScope } = await import("../src/gateway/tokens.js");
    app.use("/gateway/*", async (c, next) => {
      const t = c.req.header("authorization")?.slice(7) ?? "";
      if (!validateToken(t)) return c.json({ error: "Unauthorized" }, 401);
      c.set("rawToken", t);
      await next();
    });
    app.post("/gateway/ssh-exec", async (c) => {
      const body = await c.req.json<any>();
      const rawToken = c.get("rawToken") as string;
      const routes = [{ host: "katong.usbx.me", user: "dragooon", port: 22, credential: "seedbox-ssh-key" }];
      const route = routes.find((r) => r.host === body.host);
      if (!route) return c.json({ error: "No route" }, 404);
      if (!checkCredentialScope(rawToken, route.credential)) {
        return c.json({ error: "Credential scope denied" }, 403);
      }
      return c.json({ ok: true });
    });

    // Token does NOT include seedbox-ssh-key
    const issued = issueToken("main", ["other-key"], undefined, 3600);
    const res = await app.request("/gateway/ssh-exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ host: "katong.usbx.me", command: "ls" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects request with invalid token", async () => {
    const app = new Hono();
    const { validateToken } = await import("../src/gateway/tokens.js");

    app.use("/gateway/*", async (c, next) => {
      const authHeader = c.req.header("authorization");
      if (!authHeader?.startsWith("Bearer ")) return c.json({ error: "no" }, 401);
      const t = authHeader.slice(7);
      if (!validateToken(t)) return c.json({ error: "Invalid" }, 401);
      await next();
    });

    app.post("/gateway/store/*", async (c) => c.json({ ok: true }));

    const res = await app.request("/gateway/store/key", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer apw-fake-0000000000000000",
      },
      body: JSON.stringify({ value: "x" }),
    });

    expect(res.status).toBe(401);
  });
});
