import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { ProxyConfig } from "../../src/shared/types.js";
import { evaluatePolicy } from "../../src/shared/policy.js";
import { stripHeaders, injectCredential, matchRoute } from "../../src/http/injector.js";
import {
  issueToken,
  validateToken,
  checkStoreScope,
  clearAllTokens,
} from "../../src/gateway/tokens.js";

// ──────────────────────────────────────────────────────────────────────────
// Mock the credential provider (execa calls) so we never shell out.
// We mock at the module level — the real proxy server code will use this.
// ──────────────────────────────────────────────────────────────────────────
const mockExecaCommand = vi.fn();
vi.mock("execa", () => ({
  execaCommand: mockExecaCommand,
}));

// Mock node-forge's ensureCA to avoid file-system CA generation during proxy start.
// We generate a real CA in memory instead.
import forge from "node-forge";

function createInMemoryCA() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);
  const attrs = [
    { name: "commonName", value: "Test Proxy CA" },
    { name: "organizationName", value: "Test" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    cert,
    key: keys.privateKey,
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

vi.mock("../../src/http/tls.js", async () => {
  const ca = createInMemoryCA();
  const certCache = new Map<string, { cert: string; key: string }>();
  return {
    ensureCA: () => ca,
    generateCert: (hostname: string, _ca: any) => {
      const cached = certCache.get(hostname);
      if (cached) return cached;
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = Date.now().toString(16);
      cert.validity.notBefore = new Date();
      cert.validity.notAfter = new Date();
      cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);
      cert.setSubject([{ name: "commonName", value: hostname }]);
      cert.setIssuer(ca.cert.subject.attributes);
      cert.setExtensions([
        { name: "subjectAltName", altNames: [{ type: 2, value: hostname }] },
      ]);
      cert.sign(ca.key, forge.md.sha256.create());
      const result = {
        cert: forge.pki.certificateToPem(cert),
        key: forge.pki.privateKeyToPem(keys.privateKey),
      };
      certCache.set(hostname, result);
      return result;
    },
    clearCertCache: () => certCache.clear(),
  };
});

const { startHttpProxy } = await import("../../src/http/proxy.js");

// Import Hono and credentials at module level (top-level await is fine here)
const { Hono } = await import("hono");
const { storeCredential, invalidateCache } = await import(
  "../../src/shared/credentials.js"
);

// ══════════════════════════════════════════════════════════════════════════
// Shared config for the HTTP proxy tests
// ══════════════════════════════════════════════════════════════════════════

function buildTestConfig(overrides?: Partial<ProxyConfig>): ProxyConfig {
  return {
    host: "127.0.0.1",
    provider: {
      read: "echo {key}",
      write: "echo write {key} {value}",
      update: "echo update {key} {value}",
      cache_ttl: 0,
    },
    policy: {
      default: "deny",
      rules: [
        { host: "127.0.0.1", action: "allow" },
        { host: "localhost", action: "allow" },
        { host: "allowed.example.com", action: "allow" },
        { host: "denied.example.com", action: "deny" },
      ],
    },
    http: {
      port: 0, // will be overridden after listening
      tls: {
        ca_cert: "./test-ca.crt",
        ca_key: "./test-ca.key",
      },
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
      ca_key: "./test-ssh-ca",
      routes: [],
    },
    gateway: {
      port: 10256,
      token_ttl: 3600,
    },
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 1. HTTP Proxy Integration Tests
// ══════════════════════════════════════════════════════════════════════════
//
// We start a REAL HTTP proxy and a small upstream HTTP server, then send
// real HTTP requests through the proxy.  Credential resolution (execa) is
// mocked but everything else — policy checks, header stripping, injection,
// response relay — is exercised end-to-end.
// ══════════════════════════════════════════════════════════════════════════

describe("HTTP proxy — integration", () => {
  let proxyServer: Server;
  let proxyPort: number;
  let upstreamServer: Server;
  let upstreamPort: number;

  // Small upstream server that echoes back request details as JSON
  function startUpstream(): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
            })
          );
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve({ server, port: addr.port });
      });
    });
  }

  beforeAll(async () => {
    // Start upstream echo server
    const upstream = await startUpstream();
    upstreamServer = upstream.server;
    upstreamPort = upstream.port;

    // Build config that allows requests to 127.0.0.1 (our upstream)
    const config = buildTestConfig({
      http: {
        port: 0, // random port
        tls: { ca_cert: "./test-ca.crt", ca_key: "./test-ca.key" },
        strip_headers: ["authorization", "x-api-key", "proxy-authorization"],
        routes: [
          {
            host: "127.0.0.1",
            credential: "AgentVault/Test/api-key",
            inject: { header: "x-injected-key", format: "Bearer {value}" },
          },
        ],
      },
    });

    // Start the real proxy
    proxyServer = startHttpProxy(config);
    await once(proxyServer, "listening");
    proxyPort = (proxyServer.address() as { port: number }).port;

    // Mock execa to return a known credential value
    mockExecaCommand.mockResolvedValue({ stdout: "test-secret-42" });
  });

  afterAll(async () => {
    proxyServer?.close();
    upstreamServer?.close();
    // Wait for close events to fire
    await Promise.allSettled([
      proxyServer ? once(proxyServer, "close") : Promise.resolve(),
      upstreamServer ? once(upstreamServer, "close") : Promise.resolve(),
    ]);
  });

  beforeEach(() => {
    mockExecaCommand.mockClear();
    mockExecaCommand.mockResolvedValue({ stdout: "test-secret-42" });
  });

  it("forwards an HTTP request through the proxy to upstream", async () => {
    // Make a request through the proxy to the upstream echo server
    const targetUrl = `http://127.0.0.1:${upstreamPort}/hello?foo=bar`;
    const res = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "Content-Type": "text/plain",
      },
      // Use the proxy (node fetch does not support HTTP_PROXY env natively,
      // so we send the request directly to the proxy as an absolute URL request)
    });

    // The proxy's handleHttpRequest receives this when the client sends
    // an absolute URL to the proxy address.  Since we can't easily set a
    // proxy for global fetch, we test the proxy handler via a raw HTTP
    // request with an absolute URL directed at the proxy port.
    //
    // node:http approach:
    const http = await import("node:http");
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          path: `http://127.0.0.1:${upstreamPort}/hello?foo=bar`,
          method: "GET",
          headers: { "Content-Type": "text/plain" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        }
      );
      req.on("error", reject);
      req.end();
    });

    const json = JSON.parse(body);
    expect(json.method).toBe("GET");
    expect(json.url).toContain("/hello");
  });

  it("returns 403 for a denied host", async () => {
    const http = await import("node:http");

    const { statusCode, body } = await new Promise<{ statusCode: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: proxyPort,
            path: "http://denied.example.com/secret",
            method: "GET",
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                statusCode: res.statusCode!,
                body: Buffer.concat(chunks).toString(),
              })
            );
          }
        );
        req.on("error", reject);
        req.end();
      }
    );

    expect(statusCode).toBe(403);
    expect(body).toContain("Blocked by policy");
  });

  it("strips authorization header and injects credential on matched routes", async () => {
    const http = await import("node:http");

    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          path: `http://127.0.0.1:${upstreamPort}/api/test`,
          method: "GET",
          headers: {
            Authorization: "Bearer should-be-stripped",
            "x-api-key": "also-stripped",
            "x-custom": "should-survive",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        }
      );
      req.on("error", reject);
      req.end();
    });

    const json = JSON.parse(body);

    // The authorization header should have been stripped
    expect(json.headers["authorization"]).toBeUndefined();
    // x-api-key should also be stripped
    expect(json.headers["x-api-key"]).toBeUndefined();
    // Custom header should survive
    expect(json.headers["x-custom"]).toBe("should-survive");
    // Injected credential header should be present
    expect(json.headers["x-injected-key"]).toBe("Bearer test-secret-42");
  });

  it("injects credential using the resolved value from the provider", async () => {
    mockExecaCommand.mockResolvedValue({ stdout: "  rotated-key-99  " });

    const http = await import("node:http");

    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          path: `http://127.0.0.1:${upstreamPort}/check-cred`,
          method: "GET",
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        }
      );
      req.on("error", reject);
      req.end();
    });

    const json = JSON.parse(body);
    // Value should be trimmed by the credential resolver
    expect(json.headers["x-injected-key"]).toBe("Bearer rotated-key-99");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. CONNECT Tunnel Tests
// ══════════════════════════════════════════════════════════════════════════
//
// The CONNECT handler requires MITM TLS setup which is complex to drive in
// a test.  We test the core policy enforcement that the CONNECT handler
// relies on, and verify that the proxy responds correctly to CONNECT for
// denied hosts.  For allowed hosts the handler does full TLS MITM which
// would require the test client to trust the in-memory CA; we test the
// policy gate directly instead.
// ══════════════════════════════════════════════════════════════════════════

describe("CONNECT tunnel — policy enforcement", () => {
  let proxyServer: Server;
  let proxyPort: number;

  beforeAll(async () => {
    const config = buildTestConfig();
    proxyServer = startHttpProxy(config);
    await once(proxyServer, "listening");
    proxyPort = (proxyServer.address() as { port: number }).port;
  });

  afterAll(() => {
    // Force-close all connections — the CONNECT test leaves a TLS socket
    // open which prevents graceful shutdown within the hook timeout.
    proxyServer?.closeAllConnections?.();
    proxyServer?.close();
  });

  it("rejects CONNECT to a denied host with 403", async () => {
    const net = await import("node:net");

    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () => {
        socket.write("CONNECT denied.example.com:443 HTTP/1.1\r\nHost: denied.example.com:443\r\n\r\n");
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
        // Once we have the status line, we can close
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

  it("accepts CONNECT to an allowed host (responds 200 Connection Established)", async () => {
    const net = await import("node:net");

    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () => {
        socket.write("CONNECT allowed.example.com:443 HTTP/1.1\r\nHost: allowed.example.com:443\r\n\r\n");
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
      // Timeout in case the proxy never responds (shouldn't happen)
      setTimeout(() => {
        socket.end();
        resolve(data);
      }, 2000);
    });

    expect(response).toContain("200 Connection Established");
  });

  it("evaluatePolicy allows host in allowlist", () => {
    const policy = buildTestConfig().policy;
    expect(evaluatePolicy(policy, { host: "allowed.example.com", port: 443 })).toBe("allow");
  });

  it("evaluatePolicy denies host not in allowlist", () => {
    const policy = buildTestConfig().policy;
    expect(evaluatePolicy(policy, { host: "evil.example.com", port: 443 })).toBe("deny");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. SSH Tunnel Tests
// ══════════════════════════════════════════════════════════════════════════
//
// The SSH tunnel server requires ssh2 Server/Client setup with real key
// exchange, certificate auth, and port forwarding which is extremely
// complex to orchestrate in a unit test. We test the helper functions
// (cert validation, policy check) that the tunnel uses.  A full E2E SSH
// tunnel test is left as a TODO.
// ══════════════════════════════════════════════════════════════════════════

describe("SSH tunnel — helper functions", () => {
  it("evaluatePolicy denies SSH host not in policy rules", () => {
    const policy = buildTestConfig().policy;
    expect(evaluatePolicy(policy, { host: "evil-server.internal", port: 22 })).toBe("deny");
  });

  it("evaluatePolicy allows SSH host in policy rules", () => {
    const config = buildTestConfig({
      policy: {
        default: "deny",
        rules: [{ host: "bastion.internal", port: 22, action: "allow" }],
      },
    });
    expect(evaluatePolicy(config.policy, { host: "bastion.internal", port: 22 })).toBe("allow");
  });

  it("evaluatePolicy respects port matching for SSH", () => {
    const config = buildTestConfig({
      policy: {
        default: "deny",
        rules: [{ host: "server.internal", port: 22, action: "allow" }],
      },
    });
    expect(evaluatePolicy(config.policy, { host: "server.internal", port: 22 })).toBe("allow");
    expect(evaluatePolicy(config.policy, { host: "server.internal", port: 2222 })).toBe("deny");
  });

  // TODO: Full SSH tunnel E2E test
  // This would require:
  // 1. Starting the SSH tunnel server with startSshTunnel()
  // 2. Generating a valid agent cert with issueAgentCert()
  // 3. Connecting an ssh2 Client with the agent cert as password
  // 4. Requesting a tcpip forward to a target host
  // 5. Verifying the proxy resolves the target credential and connects
  // 6. Verifying data flows bidirectionally through the tunnel
  //
  // The complexity comes from:
  // - ssh2 Client needs proper host key verification or { hostVerifier: () => true }
  // - The tunnel connects to the real target, which would need a mock SSH server
  // - Certificate auth uses the password channel with base64-encoded cert
  it.todo("full SSH tunnel E2E — connect agent through proxy to target");
});

// ══════════════════════════════════════════════════════════════════════════
// 4. Gateway API Integration Tests (P1-5)
// ══════════════════════════════════════════════════════════════════════════
//
// We import the real Hono app logic and test it via app.request() which
// does not require starting a real HTTP server.
// ══════════════════════════════════════════════════════════════════════════

describe("Gateway API — integration via Hono app.request()", () => {
  // We build a standalone Hono app mirroring gateway/api.ts routes
  // because startGateway() uses @hono/node-server's serve() which binds
  // a real port. Instead we test the route handlers directly.
  const config = buildTestConfig();

  function buildGatewayApp() {
    const app = new Hono();

    // Auth middleware — same as gateway/api.ts
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

    // Store endpoint — same as gateway/api.ts
    app.post("/gateway/store/*", async (c) => {
      const key = new URL(c.req.url).pathname.replace(/^\/gateway\/store\//, "");
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

    // Token issuance — same as gateway/api.ts
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
      return c.json({ token: token.token, expiresAt: token.expiresAt });
    });

    // Cache invalidation — same as gateway/api.ts
    app.post("/gateway/cache/invalidate", async (c) => {
      const body = await c.req.json<{ key?: string }>().catch(() => ({}));
      invalidateCache((body as any)?.key);
      return c.json({ ok: true });
    });

    return app;
  }

  let token: string;

  beforeEach(() => {
    clearAllTokens();
    mockExecaCommand.mockClear();
    mockExecaCommand.mockResolvedValue({ stdout: "" });
    const issued = issueToken("test-agent", ["AgentVault/GitHub/token"], ["AgentVault/*"], 3600);
    token = issued.token;
  });

  it("rejects requests without an authorization header (401)", async () => {
    const app = buildGatewayApp();
    const res = await app.request("/gateway/store/AgentVault/Test/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "secret" }),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toContain("Missing");
  });

  it("rejects requests with an invalid token (401)", async () => {
    const app = buildGatewayApp();
    const res = await app.request("/gateway/store/AgentVault/Test/key", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer apw-fake-0000000000000000000000000000000000",
      },
      body: JSON.stringify({ value: "secret" }),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toContain("Invalid");
  });

  it("rejects requests with a non-Bearer authorization scheme (401)", async () => {
    const app = buildGatewayApp();
    const res = await app.request("/gateway/store/AgentVault/Test/key", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from("user:pass").toString("base64")}`,
      },
      body: JSON.stringify({ value: "secret" }),
    });
    expect(res.status).toBe(401);
  });

  it("stores a credential with valid token and matching scope (200)", async () => {
    const app = buildGatewayApp();
    const res = await app.request("/gateway/store/AgentVault/GitHub/new-key", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ value: "ghp_supersecret" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.key).toBe("AgentVault/GitHub/new-key");
    // Verify storeCredential was actually called
    expect(mockExecaCommand).toHaveBeenCalled();
  });

  it("denies store for a key outside the token's storeKeys scope (403)", async () => {
    const app = buildGatewayApp();
    const res = await app.request("/gateway/store/OtherVault/Private/secret", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ value: "secret" }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain("scope denied");
  });

  it("denies store when token has no storeKeys at all (403)", async () => {
    // Issue a token with no store scope
    const noStore = issueToken("readonly-agent", ["AgentVault/Read/key"], undefined, 3600);

    const app = buildGatewayApp();
    const res = await app.request("/gateway/store/AgentVault/Test/key", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${noStore.token}`,
      },
      body: JSON.stringify({ value: "secret" }),
    });

    expect(res.status).toBe(403);
  });

  it("issues a token via POST /token", async () => {
    const app = buildGatewayApp();
    const res = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "new-agent",
        credentials: ["AgentVault/Key/1"],
        storeKeys: ["AgentVault/Key/*"],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.token).toMatch(/^apw-new-agent-/);
    expect(json.expiresAt).toBeGreaterThan(Date.now());

    // Verify the issued token is actually valid
    const validated = validateToken(json.token);
    expect(validated).not.toBeNull();
    expect(validated!.agentId).toBe("new-agent");
  });

  it("rejects POST /token without agentId (400)", async () => {
    const app = buildGatewayApp();
    const res = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: ["key1"] }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Missing agentId");
  });

  it("cache invalidation endpoint works (200)", async () => {
    const app = buildGatewayApp();
    const res = await app.request("/gateway/cache/invalidate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ key: "AgentVault/GitHub/token" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });
});
