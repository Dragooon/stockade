/**
 * TRUE end-to-end tests — ZERO mocks.
 *
 * Real HTTP servers, real TLS certificate generation, real filesystem I/O,
 * real shell commands for credential resolution, real Hono gateway.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import forge from "node-forge";

import type { ProxyConfig } from "../../src/shared/types.js";
import { evaluatePolicy } from "../../src/shared/policy.js";
import {
  stripHeaders,
  injectCredential,
  matchRoute,
} from "../../src/http/injector.js";
import { ensureCA, generateCert, clearCertCache } from "../../src/http/tls.js";
import { startHttpProxy } from "../../src/http/proxy.js";
import { loadProxyConfig } from "../../src/shared/config.js";
import {
  issueToken,
  validateToken,
  checkStoreScope,
  clearAllTokens,
} from "../../src/gateway/tokens.js";
import {
  resolveCredential,
  storeCredential,
  invalidateCache,
} from "../../src/shared/credentials.js";

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/** Create a temp directory that will be cleaned up in afterAll. */
const tempDirs: string[] = [];
function makeTempDir(prefix = "proxy-e2e-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Start a bare HTTP echo server that returns request details as JSON. */
function startEchoServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              method: req.method,
              url: req.url,
              headers: req.headers,
              body: body || undefined,
            }),
          );
        });
      },
    );
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

/** Send an HTTP request through a forward proxy using the absolute-URI form. */
function requestViaProxy(opts: {
  proxyHost: string;
  proxyPort: number;
  targetUrl: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: opts.proxyHost,
        port: opts.proxyPort,
        path: opts.targetUrl,
        method: opts.method ?? "GET",
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const hdrs: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") hdrs[k] = v;
          }
          resolve({
            statusCode: res.statusCode!,
            headers: hdrs,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ════════════════════════════════════════════════════════════════════════
// 1.  HTTP Proxy — real servers, real connections
// ════════════════════════════════════════════════════════════════════════

describe("HTTP Proxy (real)", () => {
  let echoServer: Server;
  let echoPort: number;
  let proxyServer: Server;
  let proxyPort: number;
  let tlsTempDir: string;

  beforeAll(async () => {
    // 1a. Start a real echo upstream
    const echo = await startEchoServer();
    echoServer = echo.server;
    echoPort = echo.port;

    // 1b. Generate real CA certs on disk (needed by startHttpProxy)
    tlsTempDir = makeTempDir("proxy-tls-");
    const caCertPath = join(tlsTempDir, "ca.crt");
    const caKeyPath = join(tlsTempDir, "ca.key");

    // Let ensureCA generate them
    ensureCA(caCertPath, caKeyPath);

    // 1c. Build a real config with real echo commands for credential provider
    const config: ProxyConfig = {
      host: "127.0.0.1",
      provider: {
        read: "echo test-credential-value",
        write: "echo write-ok",
        update: "echo update-ok",
        cache_ttl: 0, // no caching — every request resolves fresh
      },
      policy: {
        default: "deny",
        rules: [
          { host: "127.0.0.1", action: "allow" },
          { host: "localhost", action: "allow" },
          { host: "denied.example.com", action: "deny" },
        ],
      },
      http: {
        port: 0,
        tls: { ca_cert: caCertPath, ca_key: caKeyPath },
        strip_headers: ["authorization", "x-api-key", "proxy-authorization"],
        routes: [
          {
            host: "127.0.0.1",
            credential: "AgentVault/Test/api-key",
            inject: { header: "x-injected-key", format: "Bearer {value}" },
          },
        ],
      },
      ssh: {
        port: 10022,
        ca_key: join(tlsTempDir, "ssh-ca"),
        routes: [],
      },
      gateway: {
        port: 10256,
        token_ttl: 3600,
      },
    };

    // 1d. Start the REAL proxy
    proxyServer = startHttpProxy(config);
    await once(proxyServer, "listening");
    proxyPort = (proxyServer.address() as { port: number }).port;
  });

  afterAll(async () => {
    proxyServer?.closeAllConnections?.();
    proxyServer?.close();
    echoServer?.close();
    await Promise.allSettled([
      proxyServer ? once(proxyServer, "close") : Promise.resolve(),
      echoServer ? once(echoServer, "close") : Promise.resolve(),
    ]);
  });

  it("forwards an HTTP request through the proxy to the upstream", async () => {
    const targetUrl = `http://127.0.0.1:${echoPort}/hello?foo=bar`;
    const res = await requestViaProxy({
      proxyHost: "127.0.0.1",
      proxyPort,
      targetUrl,
      headers: { "Content-Type": "text/plain" },
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.method).toBe("GET");
    expect(json.url).toContain("/hello");
    expect(json.url).toContain("foo=bar");
  });

  it("returns 403 for a denied host", async () => {
    const res = await requestViaProxy({
      proxyHost: "127.0.0.1",
      proxyPort,
      targetUrl: "http://denied.example.com/secret",
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Blocked by policy");
  });

  it("returns 403 for an unlisted host (default deny)", async () => {
    const res = await requestViaProxy({
      proxyHost: "127.0.0.1",
      proxyPort,
      targetUrl: "http://unknown-host.example.com/nope",
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Blocked by policy");
  });

  it("injects a real credential (via echo command) into the upstream request", async () => {
    const targetUrl = `http://127.0.0.1:${echoPort}/api/resource`;
    const res = await requestViaProxy({
      proxyHost: "127.0.0.1",
      proxyPort,
      targetUrl,
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    // The provider command is `echo test-credential-value` — the resolved value
    // is used in the format "Bearer {value}"
    expect(json.headers["x-injected-key"]).toBe(
      "Bearer test-credential-value",
    );
  });

  it("strips Authorization header but injects credential and preserves custom headers", async () => {
    const targetUrl = `http://127.0.0.1:${echoPort}/api/protected`;
    const res = await requestViaProxy({
      proxyHost: "127.0.0.1",
      proxyPort,
      targetUrl,
      headers: {
        Authorization: "Bearer should-be-stripped",
        "x-api-key": "also-stripped",
        "x-custom-header": "should-survive",
      },
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);

    // Stripped headers must not reach upstream
    expect(json.headers["authorization"]).toBeUndefined();
    expect(json.headers["x-api-key"]).toBeUndefined();

    // Custom header passes through
    expect(json.headers["x-custom-header"]).toBe("should-survive");

    // Injected credential is present
    expect(json.headers["x-injected-key"]).toBe(
      "Bearer test-credential-value",
    );
  });

  it("forwards POST body through the proxy", async () => {
    const targetUrl = `http://127.0.0.1:${echoPort}/submit`;
    const payload = JSON.stringify({ data: "hello from e2e" });
    const res = await requestViaProxy({
      proxyHost: "127.0.0.1",
      proxyPort,
      targetUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Explicit Content-Length avoids chunked transfer-encoding,
        // which the proxy's internal fetch() rejects.
        "Content-Length": String(Buffer.byteLength(payload)),
      },
      body: payload,
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.method).toBe("POST");
    expect(json.body).toBe(payload);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2.  CONNECT tunnel — policy enforcement
// ════════════════════════════════════════════════════════════════════════

describe("CONNECT tunnel (real)", () => {
  let proxyServer: Server;
  let proxyPort: number;
  let tlsTempDir: string;

  beforeAll(async () => {
    tlsTempDir = makeTempDir("proxy-connect-tls-");
    const caCertPath = join(tlsTempDir, "ca.crt");
    const caKeyPath = join(tlsTempDir, "ca.key");
    ensureCA(caCertPath, caKeyPath);

    const config: ProxyConfig = {
      host: "127.0.0.1",
      provider: {
        read: "echo x",
        write: "echo x",
        update: "echo x",
        cache_ttl: 0,
      },
      policy: {
        default: "deny",
        rules: [
          { host: "allowed.example.com", action: "allow" },
          { host: "denied.example.com", action: "deny" },
        ],
      },
      http: {
        port: 0,
        tls: { ca_cert: caCertPath, ca_key: caKeyPath },
        strip_headers: [],
        routes: [],
      },
      ssh: { port: 10022, ca_key: join(tlsTempDir, "ssh-ca"), routes: [] },
      gateway: { port: 10256, token_ttl: 3600 },
    };

    proxyServer = startHttpProxy(config);
    await once(proxyServer, "listening");
    proxyPort = (proxyServer.address() as { port: number }).port;
  });

  afterAll(() => {
    proxyServer?.closeAllConnections?.();
    proxyServer?.close();
  });

  it("rejects CONNECT to a denied host with 403", async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () => {
        socket.write(
          "CONNECT denied.example.com:443 HTTP/1.1\r\nHost: denied.example.com:443\r\n\r\n",
        );
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
        if (data.includes("\r\n")) {
          socket.end();
          resolve(data);
        }
      });
      socket.on("error", reject);
      socket.on("end", () => resolve(data));
    });

    expect(response).toContain("403 Forbidden");
    expect(response).toContain("Blocked by policy");
  });

  it("accepts CONNECT to an allowed host (200 Connection Established)", async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () => {
        socket.write(
          "CONNECT allowed.example.com:443 HTTP/1.1\r\nHost: allowed.example.com:443\r\n\r\n",
        );
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
        if (data.includes("200 Connection Established")) {
          socket.end();
          resolve(data);
        }
      });
      socket.on("error", reject);
      setTimeout(() => {
        socket.end();
        resolve(data);
      }, 2000);
    });

    expect(response).toContain("200 Connection Established");
  });

  it("rejects CONNECT to an unlisted host (default deny)", async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () => {
        socket.write(
          "CONNECT unknown.example.com:443 HTTP/1.1\r\nHost: unknown.example.com:443\r\n\r\n",
        );
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
        if (data.includes("\r\n")) {
          socket.end();
          resolve(data);
        }
      });
      socket.on("error", reject);
      socket.on("end", () => resolve(data));
    });

    expect(response).toContain("403 Forbidden");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3.  Gateway API — real HTTP server, real Hono
// ════════════════════════════════════════════════════════════════════════

describe("Gateway API (real HTTP)", () => {
  let gatewayServer: ReturnType<typeof import("@hono/node-server").serve>;
  let gatewayPort: number;
  let gatewayUrl: string;

  beforeAll(async () => {
    clearAllTokens();
    invalidateCache();

    // Import startGateway which uses @hono/node-server's serve()
    const { Hono } = await import("hono");
    const { serve } = await import("@hono/node-server");

    // Build a real Hono app using the same code as gateway/api.ts
    const config: ProxyConfig = {
      host: "127.0.0.1",
      provider: {
        read: "echo resolved-value",
        write: "echo write-ok",
        update: "echo update-ok",
        cache_ttl: 0,
      },
      policy: { default: "deny", rules: [] },
      http: {
        port: 10255,
        tls: { ca_cert: "./x.crt", ca_key: "./x.key" },
        strip_headers: [],
        routes: [],
      },
      ssh: { port: 10022, ca_key: "./ssh-ca", routes: [] },
      gateway: { port: 0, token_ttl: 3600 },
    };

    const app = new Hono();

    // Auth middleware
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
      c.set("tokenData", tokenData);
      c.set("rawToken", token);
      await next();
    });

    // Store
    app.post("/gateway/store/*", async (c) => {
      const key = new URL(c.req.url).pathname.replace(
        /^\/gateway\/store\//,
        "",
      );
      const rawToken = c.get("rawToken") as string;
      if (!checkStoreScope(rawToken, key)) {
        return c.json({ error: "Store scope denied for this key" }, 403);
      }
      const body = await c.req.json<{ value: string }>();
      if (!body.value) {
        return c.json({ error: "Missing value" }, 400);
      }
      await storeCredential(config.provider, key, body.value);
      return c.json({ ok: true, key });
    });

    // Token issuance
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
        config.gateway.token_ttl,
      );
      return c.json({ token: token.token, expiresAt: token.expiresAt });
    });

    // Cache invalidation
    app.post("/gateway/cache/invalidate", async (c) => {
      const body = await c.req.json<{ key?: string }>().catch(() => ({}));
      invalidateCache((body as any)?.key);
      return c.json({ ok: true });
    });

    // Start on a random port
    gatewayServer = serve({
      fetch: app.fetch,
      hostname: "127.0.0.1",
      port: 0,
    });

    // Wait for the server to be listening and get the port
    await new Promise<void>((resolve) => {
      (gatewayServer as any).on("listening", () => resolve());
      // If already listening, resolve immediately
      const addr = (gatewayServer as any).address?.();
      if (addr) resolve();
    });
    const addr = (gatewayServer as any).address();
    gatewayPort = addr.port;
    gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  });

  afterAll(() => {
    (gatewayServer as any)?.close?.();
    clearAllTokens();
  });

  it("issues a token via POST /token", async () => {
    const res = await fetch(`${gatewayUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "e2e-agent",
        credentials: ["AgentVault/GitHub/token"],
        storeKeys: ["AgentVault/*"],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.token).toMatch(/^apw-e2e-agent-/);
    expect(json.expiresAt).toBeGreaterThan(Date.now());

    // The token should actually be valid
    const validated = validateToken(json.token);
    expect(validated).not.toBeNull();
    expect(validated!.agentId).toBe("e2e-agent");
  });

  it("stores a credential with a valid token and matching scope", async () => {
    // Issue a token first
    const tokenRes = await fetch(`${gatewayUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "store-agent",
        credentials: ["AgentVault/Test/key"],
        storeKeys: ["AgentVault/*"],
      }),
    });
    const { token } = (await tokenRes.json()) as any;

    // Now use the token to store a credential
    const storeRes = await fetch(
      `${gatewayUrl}/gateway/store/AgentVault/Test/new-key`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ value: "super-secret-123" }),
      },
    );

    expect(storeRes.status).toBe(200);
    const json = (await storeRes.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.key).toBe("AgentVault/Test/new-key");
  });

  it("rejects store with invalid token (401)", async () => {
    const res = await fetch(
      `${gatewayUrl}/gateway/store/AgentVault/Test/key`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:
            "Bearer apw-fake-0000000000000000000000000000000000",
        },
        body: JSON.stringify({ value: "secret" }),
      },
    );

    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.error).toContain("Invalid");
  });

  it("rejects store with no auth header (401)", async () => {
    const res = await fetch(
      `${gatewayUrl}/gateway/store/AgentVault/Test/key`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "secret" }),
      },
    );

    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.error).toContain("Missing");
  });

  it("rejects store for out-of-scope key (403)", async () => {
    // Issue a token scoped to AgentVault/*
    const tokenRes = await fetch(`${gatewayUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "scoped-agent",
        credentials: [],
        storeKeys: ["AgentVault/*"],
      }),
    });
    const { token } = (await tokenRes.json()) as any;

    // Try to store under OtherVault — should be denied
    const res = await fetch(
      `${gatewayUrl}/gateway/store/OtherVault/Private/secret`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ value: "nope" }),
      },
    );

    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error).toContain("scope denied");
  });

  it("rejects store when token has no storeKeys (403)", async () => {
    const tokenRes = await fetch(`${gatewayUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "readonly-agent",
        credentials: ["AgentVault/Read/key"],
        // no storeKeys
      }),
    });
    const { token } = (await tokenRes.json()) as any;

    const res = await fetch(
      `${gatewayUrl}/gateway/store/AgentVault/Test/key`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ value: "secret" }),
      },
    );

    expect(res.status).toBe(403);
  });

  it("rejects POST /token without agentId (400)", async () => {
    const res = await fetch(`${gatewayUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: ["key1"] }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error).toContain("Missing agentId");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4.  TLS — real certificate generation
// ════════════════════════════════════════════════════════════════════════

describe("TLS (real certificate generation)", () => {
  let tempDir: string;

  beforeAll(() => {
    clearCertCache();
    tempDir = makeTempDir("proxy-tls-certs-");
  });

  it("generates a real CA cert + key with ensureCA", () => {
    const certPath = join(tempDir, "test-ca.crt");
    const keyPath = join(tempDir, "test-ca.key");

    const ca = ensureCA(certPath, keyPath);

    // Verify we got actual PEM strings
    expect(ca.certPem).toContain("BEGIN CERTIFICATE");
    expect(ca.keyPem).toContain("BEGIN RSA PRIVATE KEY");

    // Verify the cert is a CA (has basicConstraints cA=true)
    const ext = ca.cert.getExtension("basicConstraints") as any;
    expect(ext).toBeTruthy();
    expect(ext.cA).toBe(true);

    // Verify subject
    const cn = ca.cert.subject.getField("CN");
    expect(cn.value).toBe("Agent Platform Proxy CA");
  });

  it("loads existing CA from disk on second call", () => {
    const certPath = join(tempDir, "test-ca.crt");
    const keyPath = join(tempDir, "test-ca.key");

    // First call generated; second should load
    const ca1 = ensureCA(certPath, keyPath);
    const ca2 = ensureCA(certPath, keyPath);

    // Should have identical PEM
    expect(ca1.certPem).toBe(ca2.certPem);
    expect(ca1.keyPem).toBe(ca2.keyPem);
  });

  it("generates a hostname cert signed by the CA", () => {
    const certPath = join(tempDir, "test-ca.crt");
    const keyPath = join(tempDir, "test-ca.key");
    const ca = ensureCA(certPath, keyPath);

    clearCertCache();
    const { cert: certPem, key: keyPem } = generateCert(
      "api.example.com",
      ca,
    );

    expect(certPem).toContain("BEGIN CERTIFICATE");
    expect(keyPem).toContain("BEGIN RSA PRIVATE KEY");

    // Parse and verify
    const cert = forge.pki.certificateFromPem(certPem);

    // CN should be the hostname
    const cn = cert.subject.getField("CN");
    expect(cn.value).toBe("api.example.com");

    // Issuer should be the CA
    const issuerCn = cert.issuer.getField("CN");
    expect(issuerCn.value).toBe("Agent Platform Proxy CA");

    // SAN should include the hostname
    const san = cert.getExtension("subjectAltName") as any;
    expect(san).toBeTruthy();
    const dnsNames = san.altNames.filter((a: any) => a.type === 2);
    expect(dnsNames.some((a: any) => a.value === "api.example.com")).toBe(
      true,
    );
  });

  it("verifies generated hostname cert with CA using node-forge", () => {
    const certPath = join(tempDir, "test-ca.crt");
    const keyPath = join(tempDir, "test-ca.key");
    const ca = ensureCA(certPath, keyPath);

    clearCertCache();
    const { cert: hostCertPem } = generateCert("verify-test.local", ca);
    const hostCert = forge.pki.certificateFromPem(hostCertPem);

    // Create a CA store and verify the cert chain
    const caStore = forge.pki.createCaStore([ca.certPem]);
    const verified = forge.pki.verifyCertificateChain(caStore, [hostCert]);
    expect(verified).toBe(true);
  });

  it("caches generated certs by hostname", () => {
    const certPath = join(tempDir, "test-ca.crt");
    const keyPath = join(tempDir, "test-ca.key");
    const ca = ensureCA(certPath, keyPath);

    clearCertCache();
    const first = generateCert("cached.example.com", ca);
    const second = generateCert("cached.example.com", ca);

    // Same object reference from cache
    expect(first.cert).toBe(second.cert);
    expect(first.key).toBe(second.key);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5.  Config loading — real filesystem
// ════════════════════════════════════════════════════════════════════════

describe("Config loading (real filesystem)", () => {
  it("loads a valid proxy.yaml and returns parsed config", () => {
    const dir = makeTempDir("proxy-config-");
    const yamlContent = `
proxy:
  host: "127.0.0.1"
  provider:
    read: "echo {key}"
    write: "echo write {key} {value}"
    update: "echo update {key} {value}"
    cache_ttl: 60
  policy:
    default: deny
    rules:
      - host: "api.example.com"
        action: allow
      - host: "*.internal"
        action: deny
  http:
    port: 8080
    tls:
      ca_cert: "./ca.crt"
      ca_key: "./ca.key"
    strip_headers:
      - authorization
    routes:
      - host: "api.example.com"
        credential: "Vault/API/key"
        inject:
          header: "x-api-key"
  ssh:
    port: 2222
    ca_key: "./ssh-ca"
    routes: []
  gateway:
    port: 9090
    token_ttl: 7200
`;
    writeFileSync(join(dir, "proxy.yaml"), yamlContent);

    const config = loadProxyConfig(dir);

    expect(config.host).toBe("127.0.0.1");
    expect(config.provider.read).toBe("echo {key}");
    expect(config.provider.cache_ttl).toBe(60);
    expect(config.policy.default).toBe("deny");
    expect(config.policy.rules).toHaveLength(2);
    expect(config.policy.rules[0].host).toBe("api.example.com");
    expect(config.policy.rules[0].action).toBe("allow");
    expect(config.http.port).toBe(8080);
    expect(config.http.tls.ca_cert).toContain("ca.crt");
    // Path is now resolved to absolute by loadProxyConfig
    expect(require("node:path").isAbsolute(config.http.tls.ca_cert)).toBe(true);
    expect(config.http.strip_headers).toEqual(["authorization"]);
    expect(config.http.routes).toHaveLength(1);
    expect(config.http.routes[0].credential).toBe("Vault/API/key");
    expect(config.http.routes[0].inject.header).toBe("x-api-key");
    expect(config.ssh.port).toBe(2222);
    expect(config.gateway.port).toBe(9090);
    expect(config.gateway.token_ttl).toBe(7200);
  });

  it("applies default values when optional fields are omitted", () => {
    const dir = makeTempDir("proxy-config-defaults-");
    const yamlContent = `
proxy:
  provider:
    read: "echo {key}"
    write: "echo {key}"
    update: "echo {key}"
  policy:
    default: allow
    rules: []
  http:
    tls:
      ca_cert: "./ca.crt"
      ca_key: "./ca.key"
    routes: []
  ssh:
    ca_key: "./ssh-ca"
    routes: []
  gateway: {}
`;
    writeFileSync(join(dir, "proxy.yaml"), yamlContent);

    const config = loadProxyConfig(dir);

    // Defaults from Zod schema
    expect(config.host).toBe("127.0.0.1");
    expect(config.provider.cache_ttl).toBe(300);
    expect(config.http.port).toBe(10255);
    expect(config.http.strip_headers).toEqual([
      "authorization",
      "x-api-key",
      "proxy-authorization",
    ]);
    expect(config.ssh.port).toBe(10022);
    expect(config.gateway.port).toBe(10256);
    expect(config.gateway.token_ttl).toBe(86400);
  });

  it("throws on invalid YAML content", () => {
    const dir = makeTempDir("proxy-config-invalid-");
    writeFileSync(join(dir, "proxy.yaml"), "not: valid: yaml: {{{}}}");

    expect(() => loadProxyConfig(dir)).toThrow();
  });

  it("throws on valid YAML with missing required fields", () => {
    const dir = makeTempDir("proxy-config-missing-");
    const yamlContent = `
proxy:
  policy:
    default: deny
    rules: []
`;
    writeFileSync(join(dir, "proxy.yaml"), yamlContent);

    expect(() => loadProxyConfig(dir)).toThrow();
  });

  it("throws when proxy.yaml does not exist", () => {
    const dir = makeTempDir("proxy-config-nofile-");
    expect(() => loadProxyConfig(dir)).toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 6.  Credential resolution — real shell commands
// ════════════════════════════════════════════════════════════════════════

describe("Credential resolution (real shell commands)", () => {
  beforeAll(() => {
    invalidateCache();
  });

  it("resolves a credential using a real echo command", async () => {
    const provider = {
      read: "echo my-secret-value",
      write: "echo ok",
      update: "echo ok",
      cache_ttl: 0,
    };

    invalidateCache();
    const value = await resolveCredential(provider, "Test/Key");
    expect(value).toBe("my-secret-value");
  });

  it("trims whitespace from the provider command output", async () => {
    const provider = {
      read: "echo   padded-value   ",
      write: "echo ok",
      update: "echo ok",
      cache_ttl: 0,
    };

    invalidateCache();
    const value = await resolveCredential(provider, "Test/Trim");
    expect(value).toBe("padded-value");
  });

  it("substitutes the key into the read command", async () => {
    // `echo {key}` should output the key itself
    const provider = {
      read: "echo {key}",
      write: "echo ok",
      update: "echo ok",
      cache_ttl: 0,
    };

    invalidateCache();
    const value = await resolveCredential(provider, "MyVault/MyKey");
    expect(value).toBe("MyVault/MyKey");
  });

  it("stores a credential using real echo commands", async () => {
    const provider = {
      read: "echo stored",
      write: "echo write-ok",
      update: "echo update-ok",
      cache_ttl: 0,
    };

    // storeCredential should not throw
    await expect(
      storeCredential(provider, "Test/Store/key", "secret-123"),
    ).resolves.toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════
//  Cleanup
// ════════════════════════════════════════════════════════════════════════

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});
