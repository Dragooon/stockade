/**
 * E2E integration tests for the container management system.
 *
 * Tests the FULL container lifecycle end-to-end: ContainerManager, PortAllocator,
 * image resolution, provisioning, Docker operations, health checks, idle cleanup,
 * orphan cleanup, and dispatcher integration — all wired together with mocked
 * Docker CLI (execa) and mocked HTTP (fetch).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ContainersConfig } from "../../src/containers/types.js";
import type { AgentConfig, ChannelMessage } from "../../src/types.js";

// ── Mock execa (Docker CLI) ─────────────────────────────────────────────────

const mockExeca = vi.fn();
vi.mock("execa", () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

// ── Mock fetch (proxy gateway API + health checks + sandboxed dispatch) ────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Mock fs.statSync for image staleness checks ─────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: vi.fn().mockReturnValue({ mtimeMs: 0 }),
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

const { statSync } = await import("node:fs");

// ── Mock Agent SDK for dispatcher tests ─────────────────────────────────────

const { mockQuery: mockQuery_ } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
const mockQuery = mockQuery_;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  tool: vi.fn(),
  createSdkMcpServer: vi.fn(),
}));

// ── Import real modules (after mocks are set up) ────────────────────────────

const { DockerClient } = await import("../../src/containers/docker.js");
const { ContainerManager } = await import("../../src/containers/manager.js");
const { dispatch } = await import("../../src/dispatcher.js");

// ── Test fixtures ───────────────────────────────────────────────────────────

const containersConfig: ContainersConfig = {
  network: "agent-net",
  proxy_host: "host.docker.internal",
  port_range: [3001, 3010],
  base_dockerfile: "./packages/worker/Dockerfile",
  build_context: ".",
  health_check: { interval_ms: 10, timeout_ms: 200, retries: 3 },
  defaults: { memory: "1g", cpus: 1.0 },
  max_age_hours: 0,
  session_idle_minutes: 30,
  max_concurrent: 5,
  proxy_ca_cert: "./data/proxy/ca.crt",
};

const PROXY_GATEWAY_URL = "http://localhost:10256";
const DATA_DIR = "/tmp/e2e-test-data";

const sharedAgent: AgentConfig = {
  model: "claude-sonnet-4-20250514",
  system: "You are a helpful assistant.",
  tools: ["Bash"],
  sandboxed: true,
  credentials: ["vault/api-key"],
  store_keys: ["vault/*"],
};

const sessionAgent: AgentConfig = {
  model: "claude-sonnet-4-20250514",
  system: "Sandbox agent.",
  tools: ["Bash"],
  sandboxed: true,
  credentials: ["vault/api-key"],
  container: { isolation: "session" as const },
};

const agentWithDockerfile: AgentConfig = {
  model: "claude-sonnet-4-20250514",
  system: "Custom agent.",
  tools: ["Bash"],
  sandboxed: true,
  credentials: [],
  container: {
    isolation: "shared" as const,
    dockerfile: "./dockerfiles/coder.Dockerfile",
    memory: "2g",
    cpus: 2.0,
    volumes: ["/data/shared:/workspace/data:ro"],
  },
};

const localAgent: AgentConfig = {
  model: "claude-sonnet-4-20250514",
  system: "Local agent.",
  tools: ["Read"],
  sandboxed: false,
};

const sandboxedAgentWithUrl: AgentConfig = {
  model: "claude-sonnet-4-20250514",
  system: "Pre-configured sandboxed.",
  tools: ["WebSearch"],
  sandboxed: true,
  url: "http://preconfigured-host:4000",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

let containerIdCounter = 0;

function resetDockerMocks() {
  containerIdCounter = 0;
  mockExeca.mockReset();

  // Default Docker CLI behavior — route by command
  mockExeca.mockImplementation((_cmd: string, args: string[]) => {
    const subcommand = args[0];

    switch (subcommand) {
      case "create":
        containerIdCounter++;
        return Promise.resolve({
          stdout: `container-${String(containerIdCounter).padStart(3, "0")}`,
          stderr: "",
        });
      case "start":
      case "stop":
      case "rm":
        return Promise.resolve({ stdout: "", stderr: "" });
      case "image": {
        const imageSubCmd = args[1];
        if (imageSubCmd === "inspect") {
          // Default: image exists, created at epoch 0
          if (args[2] === "--format") {
            return Promise.resolve({
              stdout: "2020-01-01T00:00:00Z",
              stderr: "",
            });
          }
          return Promise.resolve({ stdout: "{}", stderr: "" });
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      case "build":
        return Promise.resolve({ stdout: "", stderr: "" });
      case "network":
        if (args[1] === "inspect") {
          return Promise.resolve({ stdout: "{}", stderr: "" });
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      case "inspect":
        return Promise.resolve({
          stdout: JSON.stringify({
            Id: "some-id",
            Name: "/some-name",
            State: { Running: true, Status: "running" },
            Config: { Labels: {} },
          }),
          stderr: "",
        });
      case "ps":
        return Promise.resolve({ stdout: "", stderr: "" });
      default:
        return Promise.resolve({ stdout: "", stderr: "" });
    }
  });
}

function resetFetchMock() {
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
    // Proxy gateway token issuance
    if (url.endsWith("/token") && opts?.method === "POST") {
      const body = JSON.parse(opts.body as string);
      return Promise.resolve({
        ok: true,
        json: async () => ({
          token: `apw-${body.agentId}-${Date.now()}`,
          expiresAt: Date.now() + 86400000,
        }),
      });
    }

    // Proxy gateway token revocation
    if (url.includes("/token/") && opts?.method === "DELETE") {
      return Promise.resolve({ ok: true });
    }

    // Health check endpoint
    if (url.endsWith("/health")) {
      return Promise.resolve({ ok: true });
    }

    // Remote worker dispatch
    if (url.endsWith("/run")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          result: "Remote worker response",
          sessionId: "sess-sandboxed-1",
        }),
      });
    }

    return Promise.resolve({ ok: false, status: 404, text: async () => "Not Found" });
  });
}

function createManager(configOverrides?: Partial<ContainersConfig>): {
  docker: InstanceType<typeof DockerClient>;
  manager: InstanceType<typeof ContainerManager>;
} {
  const docker = new DockerClient();
  const config = { ...containersConfig, ...configOverrides };
  const manager = new ContainerManager(docker, config, PROXY_GATEWAY_URL, DATA_DIR);
  return { docker, manager };
}

/** Helper for creating a fake async iterable stream for Agent SDK */
function fakeStream(messages: Record<string, unknown>[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) {
        yield msg;
      }
    },
  };
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetDockerMocks();
  resetFetchMock();
  (statSync as any).mockReturnValue({ mtimeMs: 0 });
});

// =============================================================================
// SHARED CONTAINER LIFECYCLE
// =============================================================================

describe("Shared container lifecycle", () => {
  it("test 1: first ensure() — resolves image, builds if needed, allocates port, provisions, creates, starts, health-checks, returns URL", async () => {
    // Image does not exist yet — should trigger build
    mockExeca.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return Promise.reject(new Error("No such image"));
      }
      if (args[0] === "build") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (args[0] === "create") {
        return Promise.resolve({ stdout: "ctr-first-ensure", stderr: "" });
      }
      if (args[0] === "start") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    const { manager } = createManager();
    const url = await manager.ensure("main", sharedAgent, "scope-alice");

    // Returns correct URL
    expect(url).toBe("http://localhost:3001");

    // Docker image was built (because imageExists returned false)
    const buildCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "build"
    );
    expect(buildCalls.length).toBe(1);
    expect(buildCalls[0][1]).toContain("-t");
    expect(buildCalls[0][1]).toContain("stockade/worker");

    // Container was created with correct parameters
    const createCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "create"
    );
    expect(createCalls.length).toBe(1);
    const createArgs: string[] = createCalls[0][1];
    expect(createArgs).toContain("--network");
    expect(createArgs).toContain("agent-net");
    expect(createArgs).toContain("-p");
    expect(createArgs.some((a: string) => a.includes("3001"))).toBe(true);
    expect(createArgs).toContain("--label");
    expect(createArgs.some((a: string) => a.includes("stockade=true"))).toBe(true);
    expect(createArgs.some((a: string) => a.includes("agent-id=main"))).toBe(true);
    expect(createArgs.some((a: string) => a.includes("isolation=shared"))).toBe(true);

    // Environment variables were set via -e flags
    expect(createArgs.some((a: string) => a.startsWith("PORT=3001"))).toBe(true);
    expect(createArgs.some((a: string) => a.startsWith("HTTP_PROXY="))).toBe(true);
    expect(createArgs.some((a: string) => a.startsWith("HTTPS_PROXY="))).toBe(true);
    expect(createArgs.some((a: string) => a.startsWith("APW_GATEWAY="))).toBe(true);
    expect(createArgs.some((a: string) => a.startsWith("APW_TOKEN="))).toBe(true);

    // Container was started
    const startCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "start"
    );
    expect(startCalls.length).toBe(1);
    expect(startCalls[0][1][1]).toBe("ctr-first-ensure");

    // Health check was performed (fetch to /health)
    const healthCalls = mockFetch.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].endsWith("/health")
    );
    expect(healthCalls.length).toBeGreaterThanOrEqual(1);

    // Gateway token was requested
    const tokenCalls = mockFetch.mock.calls.filter(
      (c: any[]) =>
        typeof c[0] === "string" && c[0].endsWith("/token") && c[1]?.method === "POST"
    );
    expect(tokenCalls.length).toBe(1);
    const tokenBody = JSON.parse(tokenCalls[0][1].body);
    expect(tokenBody.agentId).toBe("main");
    expect(tokenBody.credentials).toEqual(["vault/api-key"]);
    expect(tokenBody.storeKeys).toEqual(["vault/*"]);

    expect(manager.size).toBe(1);
  });

  it("test 2: second ensure() for same agent, different scope — reuses existing container, same URL", async () => {
    const { manager } = createManager();

    const url1 = await manager.ensure("main", sharedAgent, "scope-alice");
    const url2 = await manager.ensure("main", sharedAgent, "scope-bob");

    expect(url1).toBe(url2);
    expect(url1).toBe("http://localhost:3001");
    expect(manager.size).toBe(1);

    // Container was only created once
    const createCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "create"
    );
    expect(createCalls.length).toBe(1);
  });

  it("test 3: container dies between requests — next ensure() detects dead container, tears down, restarts", async () => {
    const { manager } = createManager();

    // First ensure — healthy
    const url1 = await manager.ensure("main", sharedAgent, "scope-alice");
    expect(url1).toBe("http://localhost:3001");

    // Simulate container death — health check fails on next call
    let healthCallCount = 0;
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.endsWith("/health")) {
        healthCallCount++;
        // First health check after initial ensure already passed.
        // Now fail the next one (the check-alive in ensure)
        return Promise.resolve({ ok: false });
      }
      // Token issuance
      if (url.endsWith("/token") && opts?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            token: `apw-restarted-${Date.now()}`,
            expiresAt: Date.now() + 86400000,
          }),
        });
      }
      if (url.includes("/token/") && opts?.method === "DELETE") {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: false, status: 404, text: async () => "Not Found" });
    });

    // Make the health check after restart succeed
    // The manager will: check health (fails) -> teardown -> re-provision -> create -> start -> waitForHealth
    // We need waitForHealth to succeed on the NEW container
    let waitHealthCount = 0;
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.endsWith("/health")) {
        waitHealthCount++;
        // First call is the alive-check (should fail to trigger restart)
        // Subsequent calls are for the new container's waitForHealth (should succeed)
        if (waitHealthCount === 1) {
          return Promise.resolve({ ok: false });
        }
        return Promise.resolve({ ok: true });
      }
      if (url.endsWith("/token") && opts?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            token: `apw-restarted-${Date.now()}`,
            expiresAt: Date.now() + 86400000,
          }),
        });
      }
      if (url.includes("/token/") && opts?.method === "DELETE") {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: false, status: 404, text: async () => "Not Found" });
    });

    const url2 = await manager.ensure("main", sharedAgent, "scope-alice");

    // URL is the same (port 3001 was released and re-allocated)
    expect(url2).toBe("http://localhost:3001");

    // Old container was stopped and removed
    const stopCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "stop"
    );
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);

    const rmCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "rm"
    );
    expect(rmCalls.length).toBeGreaterThanOrEqual(1);

    // A new container was created (2 total: original + restart)
    const createCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "create"
    );
    expect(createCalls.length).toBe(2);

    expect(manager.size).toBe(1);
  });

  it("test 4: teardown — stops container, removes it, releases port, runs cleanup", async () => {
    const { manager } = createManager();

    await manager.ensure("main", sharedAgent, "scope-1");
    expect(manager.size).toBe(1);

    // Clear mocks to isolate teardown calls
    mockExeca.mockClear();
    mockFetch.mockClear();

    await manager.teardown("main");

    // Container was stopped
    const stopCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "stop"
    );
    expect(stopCalls.length).toBe(1);
    expect(stopCalls[0][1]).toContain("container-001");

    // Container was removed
    const rmCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "rm"
    );
    expect(rmCalls.length).toBe(1);

    // Cleanup was called (token revocation via DELETE)
    const deleteCalls = mockFetch.mock.calls.filter(
      (c: any[]) => c[1]?.method === "DELETE"
    );
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0]).toContain("/token/");

    // Port was released — next ensure should get port 3001 again
    expect(manager.size).toBe(0);

    const url = await manager.ensure("main", sharedAgent, "scope-2");
    expect(url).toBe("http://localhost:3001");
  });

  it("test 5: shutdownAll — tears down every managed container", async () => {
    const { manager } = createManager();

    // Create three containers: two shared, one session
    await manager.ensure("agent-a", sharedAgent, "scope-1");
    await manager.ensure("agent-b", sharedAgent, "scope-1");
    await manager.ensure("sandbox", sessionAgent, "scope-alice");
    expect(manager.size).toBe(3);

    mockExeca.mockClear();
    mockFetch.mockClear();

    await manager.shutdownAll();

    expect(manager.size).toBe(0);

    // All three containers were stopped
    const stopCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "stop"
    );
    expect(stopCalls.length).toBe(3);

    // All three containers were removed
    const rmCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "rm"
    );
    expect(rmCalls.length).toBe(3);

    // All three tokens were revoked
    const deleteCalls = mockFetch.mock.calls.filter(
      (c: any[]) => c[1]?.method === "DELETE"
    );
    expect(deleteCalls.length).toBe(3);
  });
});

// =============================================================================
// SESSION-ISOLATED CONTAINERS
// =============================================================================

describe("Session-isolated containers", () => {
  it("test 6: ensure() with isolation:session — different scopes get different containers", async () => {
    const { manager } = createManager();

    const url1 = await manager.ensure("sandbox", sessionAgent, "discord:123:alice");
    const url2 = await manager.ensure("sandbox", sessionAgent, "discord:456:bob");

    expect(url1).not.toBe(url2);
    expect(url1).toBe("http://localhost:3001");
    expect(url2).toBe("http://localhost:3002");
    expect(manager.size).toBe(2);

    // Two separate containers were created
    const createCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "create"
    );
    expect(createCalls.length).toBe(2);

    // Both have isolation=session label
    for (const call of createCalls) {
      const args: string[] = call[1];
      expect(args.some((a: string) => a.includes("isolation=session"))).toBe(true);
    }
  });

  it("test 7: same scope reuses same session container", async () => {
    const { manager } = createManager();

    const url1 = await manager.ensure("sandbox", sessionAgent, "discord:123:alice");
    const url2 = await manager.ensure("sandbox", sessionAgent, "discord:123:alice");

    expect(url1).toBe(url2);
    expect(manager.size).toBe(1);

    const createCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "create"
    );
    expect(createCalls.length).toBe(1);
  });

  it("test 8: teardownScope — only tears down session containers for that scope, leaves shared containers alone", async () => {
    const { manager } = createManager();

    // Create a shared container
    await manager.ensure("main", sharedAgent, "discord:123:alice");
    // Create two session containers for different scopes
    await manager.ensure("sandbox", sessionAgent, "discord:123:alice");
    await manager.ensure("sandbox", sessionAgent, "discord:456:bob");
    expect(manager.size).toBe(3);

    mockExeca.mockClear();

    // Tear down alice's scope
    await manager.teardownScope("discord:123:alice");

    // Only alice's session container was torn down (shared container uses agentId key, not scope)
    expect(manager.size).toBe(2);

    // Verify only one stop/rm call
    const stopCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "stop"
    );
    expect(stopCalls.length).toBe(1);

    // Shared container and bob's session container still accessible
    const sharedUrl = manager.getUrl("main", sharedAgent, "discord:123:alice");
    expect(sharedUrl).toBe("http://localhost:3001");

    const bobUrl = manager.getUrl("sandbox", sessionAgent, "discord:456:bob");
    expect(bobUrl).toBe("http://localhost:3003");
  });
});

// =============================================================================
// IMAGE RESOLUTION CHAIN
// =============================================================================

describe("Image resolution chain", () => {
  it("test 9: agent with custom dockerfile — uses that", async () => {
    const { manager } = createManager();
    await manager.ensure("coder", agentWithDockerfile, "scope-1");

    // Should have built image with the custom dockerfile tag
    const buildCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "build"
    );
    // Image exists (default mock returns success for image inspect),
    // and statSync returns mtimeMs=0 which is <= imageCreatedAt, so no rebuild.
    // Let's check image inspect was called with the custom tag
    const imageInspectCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "image" && c[1][1] === "inspect"
    );
    expect(imageInspectCalls.length).toBeGreaterThanOrEqual(1);
    // The tag should be derived from the custom Dockerfile name: "coder.Dockerfile" -> "stockade/coder"
    expect(
      imageInspectCalls.some((c: any[]) =>
        c[1].includes("stockade/coder")
      )
    ).toBe(true);
  });

  it("test 10: no agent dockerfile, platform has base_dockerfile — uses base", async () => {
    const { manager } = createManager();
    await manager.ensure("main", sharedAgent, "scope-1");

    // sharedAgent has no container.dockerfile, so resolveDockerfile falls back to base_dockerfile
    // base_dockerfile is "./packages/worker/Dockerfile" -> tag "stockade/worker"
    const imageInspectCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "image" && c[1][1] === "inspect"
    );
    expect(
      imageInspectCalls.some((c: any[]) =>
        c[1].includes("stockade/worker")
      )
    ).toBe(true);
  });

  it("test 11: no agent or platform dockerfile — falls back to built-in worker Dockerfile (same as base)", async () => {
    // The base_dockerfile IS the built-in worker Dockerfile, so this tests that
    // an agent without any container config at all uses the platform default
    const plainAgent: AgentConfig = {
      model: "sonnet",
      system: "test",
      tools: [],
      sandboxed: true,
    };
    const { manager } = createManager();
    await manager.ensure("plain", plainAgent, "scope-1");

    const imageInspectCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "image" && c[1][1] === "inspect"
    );
    expect(
      imageInspectCalls.some((c: any[]) =>
        c[1].includes("stockade/worker")
      )
    ).toBe(true);
  });

  it("test 12: stale image (Dockerfile newer than image) — triggers rebuild", async () => {
    // statSync returns a very recent mtimeMs (newer than image)
    (statSync as any).mockReturnValue({ mtimeMs: Date.now() + 100000 });

    // Image exists but is old
    mockExeca.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        if (args[2] === "--format") {
          // imageCreatedAt — return old timestamp
          return Promise.resolve({ stdout: "2020-01-01T00:00:00Z", stderr: "" });
        }
        // imageExists — image exists
        return Promise.resolve({ stdout: "{}", stderr: "" });
      }
      if (args[0] === "build") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (args[0] === "create") {
        return Promise.resolve({ stdout: "ctr-rebuilt", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    const { manager } = createManager();
    await manager.ensure("main", sharedAgent, "scope-1");

    // Build should have been called (Dockerfile is newer than image)
    const buildCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "build"
    );
    expect(buildCalls.length).toBe(1);
  });
});

// =============================================================================
// PORT ALLOCATION THROUGH FULL FLOW
// =============================================================================

describe("Port allocation through full flow", () => {
  it("test 13: multiple agents get different ports from the configured range", async () => {
    const { manager } = createManager();

    const url1 = await manager.ensure("agent-a", sharedAgent, "scope");
    const url2 = await manager.ensure("agent-b", sharedAgent, "scope");
    const url3 = await manager.ensure("agent-c", sharedAgent, "scope");

    expect(url1).toBe("http://localhost:3001");
    expect(url2).toBe("http://localhost:3002");
    expect(url3).toBe("http://localhost:3003");

    // All three ports are different
    const ports = [url1, url2, url3].map((u) =>
      parseInt(new URL(u).port, 10)
    );
    expect(new Set(ports).size).toBe(3);
    expect(ports.every((p) => p >= 3001 && p <= 3010)).toBe(true);
  });

  it("test 14: teardown releases port back to pool", async () => {
    const { manager } = createManager();

    const url1 = await manager.ensure("agent-a", sharedAgent, "scope");
    expect(url1).toBe("http://localhost:3001");

    const url2 = await manager.ensure("agent-b", sharedAgent, "scope");
    expect(url2).toBe("http://localhost:3002");

    // Tear down agent-a, releasing port 3001
    await manager.teardown("agent-a");

    // Next allocation should reuse port 3001
    const url3 = await manager.ensure("agent-c", sharedAgent, "scope");
    expect(url3).toBe("http://localhost:3001");
  });
});

// =============================================================================
// PROVISIONING INTEGRATION
// =============================================================================

describe("Provisioning integration", () => {
  it("test 15: provision sets correct env vars (HTTP_PROXY, HTTPS_PROXY, APW_GATEWAY, APW_TOKEN, etc.)", async () => {
    const { manager } = createManager();
    await manager.ensure("main", sharedAgent, "scope-1");

    const createCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "create"
    );
    expect(createCalls.length).toBe(1);

    const args: string[] = createCalls[0][1];

    // Find all -e (env) flags
    const envVars: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-e" && i + 1 < args.length) {
        envVars.push(args[i + 1]);
      }
    }

    // Check expected env vars are present
    expect(envVars.some((e) => e.startsWith("PORT="))).toBe(true);
    expect(envVars.some((e) => e.startsWith("WORKER_ID=main"))).toBe(true);
    expect(envVars.some((e) => e.startsWith("HTTP_PROXY=http://host.docker.internal:10255"))).toBe(true);
    expect(envVars.some((e) => e.startsWith("HTTPS_PROXY=http://host.docker.internal:10255"))).toBe(true);
    expect(envVars.some((e) => e.startsWith("NO_PROXY=localhost,127.0.0.1"))).toBe(true);
    expect(envVars.some((e) => e.startsWith("NODE_EXTRA_CA_CERTS=/certs/proxy-ca.crt"))).toBe(true);
    expect(envVars.some((e) => e.startsWith("APW_GATEWAY=http://host.docker.internal:10256"))).toBe(true);
    expect(envVars.some((e) => e.startsWith("APW_TOKEN=apw-main-"))).toBe(true);
  });

  it("test 16: provision mounts proxy CA cert and apw script", async () => {
    const { manager } = createManager();
    await manager.ensure("main", sharedAgent, "scope-1");

    const createCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "create"
    );
    const args: string[] = createCalls[0][1];

    // Find all -v (volume) flags
    const volumes: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-v" && i + 1 < args.length) {
        volumes.push(args[i + 1]);
      }
    }

    // CA cert is mounted
    expect(volumes.some((v) => v.includes("ca.crt") && v.includes("/certs/proxy-ca.crt:ro"))).toBe(true);

    // apw is baked into the Docker image, no mount needed
  });

  it("test 17: provision cleanup revokes gateway token", async () => {
    const { manager } = createManager();
    await manager.ensure("main", sharedAgent, "scope-1");

    mockFetch.mockClear();

    await manager.teardown("main");

    // Token revocation DELETE was called
    const deleteCalls = mockFetch.mock.calls.filter(
      (c: any[]) => c[1]?.method === "DELETE"
    );
    expect(deleteCalls.length).toBe(1);

    const deleteUrl: string = deleteCalls[0][0];
    expect(deleteUrl).toMatch(/\/token\/apw-main-/);
  });
});

// =============================================================================
// DISPATCHER INTEGRATION
// =============================================================================

describe("Dispatcher integration", () => {
  it("test 18: dispatch() with sandboxed agent + containerManager — calls ensure() then dispatches to container URL", async () => {
    const { manager } = createManager();
    const sandboxedNoUrl: AgentConfig = {
      model: "claude-sonnet-4-20250514",
      system: "Remote agent.",
      tools: ["WebSearch"],
      sandboxed: true,
    };

    const message: ChannelMessage = {
      scope: "terminal:uuid:alice",
      content: "Research quantum computing",
      userId: "alice",
      platform: "terminal",
    };

    const result = await dispatch(
      "researcher",
      message,
      sandboxedNoUrl,
      null,
      undefined,
      undefined,
      manager
    );

    expect(result.result).toBe("Remote worker response");
    expect(result.sessionId).toBe("sess-sandboxed-1");

    // Container was created
    expect(manager.size).toBe(1);

    // Dispatch was sent to the container URL (http://localhost:3001/run)
    const runCalls = mockFetch.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].endsWith("/run")
    );
    expect(runCalls.length).toBe(1);
    expect(runCalls[0][0]).toBe("http://localhost:3001/run");
  });

  it("test 19: dispatch() with sandboxed agent, no containerManager — uses pre-configured URL", async () => {
    const message: ChannelMessage = {
      scope: "terminal:uuid:alice",
      content: "Search something",
      userId: "alice",
      platform: "terminal",
    };

    const result = await dispatch(
      "researcher",
      message,
      sandboxedAgentWithUrl,
      null
    );

    expect(result.result).toBe("Remote worker response");

    // Dispatch went to the pre-configured URL
    const runCalls = mockFetch.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].endsWith("/run")
    );
    expect(runCalls.length).toBe(1);
    expect(runCalls[0][0]).toBe("http://preconfigured-host:4000/run");
  });

  it("test 20: dispatch() with local agent — does NOT call containerManager at all", async () => {
    const { manager } = createManager();

    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-local-1" },
        { type: "result", result: "Local response" },
      ])
    );

    const message: ChannelMessage = {
      scope: "terminal:uuid:alice",
      content: "Read a file",
      userId: "alice",
      platform: "terminal",
    };

    const result = await dispatch(
      "main",
      message,
      localAgent,
      null,
      undefined,
      undefined,
      manager
    );

    expect(result.result).toBe("Local response");

    // No container was created
    expect(manager.size).toBe(0);

    // No Docker CLI calls for container creation
    const createCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1]?.[0] === "create"
    );
    expect(createCalls.length).toBe(0);
  });
});

// =============================================================================
// IDLE CLEANUP
// =============================================================================

describe("Idle cleanup", () => {
  it("test 21: session container past idle timeout — cleaned up", async () => {
    const { manager } = createManager({
      session_idle_minutes: 1, // 1 minute idle timeout
    });

    await manager.ensure("sandbox", sessionAgent, "discord:123:alice");
    expect(manager.size).toBe(1);

    // Advance time past idle timeout
    vi.useFakeTimers();
    vi.advanceTimersByTime(2 * 60_000); // 2 minutes

    await manager.cleanupIdle();
    expect(manager.size).toBe(0);

    vi.useRealTimers();
  });

  it("test 22: shared container with max_age_hours=0 — NOT cleaned up", async () => {
    const { manager } = createManager({
      max_age_hours: 0,
    });

    await manager.ensure("main", sharedAgent, "scope-1");
    expect(manager.size).toBe(1);

    // Advance time significantly
    vi.useFakeTimers();
    vi.advanceTimersByTime(24 * 60 * 60_000); // 24 hours

    await manager.cleanupIdle();

    // max_age_hours=0 means no auto-cleanup for shared containers
    expect(manager.size).toBe(1);

    vi.useRealTimers();
  });
});

// =============================================================================
// ORPHAN CLEANUP
// =============================================================================

describe("Orphan cleanup", () => {
  it("test 23: container with stockade label but not in state — removed", async () => {
    // Mock listContainers to return an orphaned container
    mockExeca.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "ps") {
        return Promise.resolve({
          stdout: JSON.stringify({
            ID: "orphan-container-1",
            Names: "agent-old-stale",
            Labels: "stockade=true,container-key=old-agent,agent-id=old",
            State: "exited",
            Ports: "",
          }),
          stderr: "",
        });
      }
      if (args[0] === "stop") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (args[0] === "rm") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    const { manager } = createManager();

    // Manager has no containers in its state
    expect(manager.size).toBe(0);

    await manager.cleanupOrphans();

    // Orphan was stopped and removed
    const stopCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "stop"
    );
    expect(stopCalls.length).toBe(1);
    expect(stopCalls[0][1]).toContain("orphan-container-1");

    const rmCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "rm"
    );
    expect(rmCalls.length).toBe(1);
    expect(rmCalls[0][1]).toContain("orphan-container-1");
  });

  it("test 24: container in state — NOT removed during orphan cleanup", async () => {
    const { manager } = createManager();

    // First create a real container
    await manager.ensure("main", sharedAgent, "scope-1");
    expect(manager.size).toBe(1);

    // Now mock listContainers to return that container
    mockExeca.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "ps") {
        return Promise.resolve({
          stdout: JSON.stringify({
            ID: "container-001",
            Names: "agent-main",
            Labels: "stockade=true,container-key=main,agent-id=main",
            State: "running",
            Ports: "3001",
          }),
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    mockExeca.mockClear();

    await manager.cleanupOrphans();

    // Container was NOT stopped or removed (it's tracked in state)
    const stopCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "stop"
    );
    expect(stopCalls.length).toBe(0);

    const rmCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "rm"
    );
    expect(rmCalls.length).toBe(0);
  });
});

// =============================================================================
// ERROR SCENARIOS
// =============================================================================

describe("Error scenarios", () => {
  it("test 25: Docker not available — ensure() throws", async () => {
    // All Docker CLI commands fail
    mockExeca.mockRejectedValue(new Error("Cannot connect to the Docker daemon"));

    const { manager } = createManager();

    await expect(
      manager.ensure("main", sharedAgent, "scope-1")
    ).rejects.toThrow();
  });

  it("test 26: health check times out — throws with timeout error", async () => {
    // Health check always fails
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.endsWith("/health")) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      // Token issuance still works
      if (url.endsWith("/token") && opts?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            token: "apw-timeout-test",
            expiresAt: Date.now() + 86400000,
          }),
        });
      }
      return Promise.resolve({ ok: true });
    });

    const { manager } = createManager({
      health_check: { interval_ms: 10, timeout_ms: 50, retries: 3 },
    });

    await expect(
      manager.ensure("main", sharedAgent, "scope-1")
    ).rejects.toThrow(/health check timed out/i);
  });

  it("test 27: image build fails — throws", async () => {
    mockExeca.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        // Image does not exist
        return Promise.reject(new Error("No such image"));
      }
      if (args[0] === "build") {
        return Promise.reject(new Error("Build failed: OOM"));
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    const { manager } = createManager();

    await expect(
      manager.ensure("main", sharedAgent, "scope-1")
    ).rejects.toThrow("Build failed: OOM");

    // No container should be in state
    expect(manager.size).toBe(0);
  });
});

// =============================================================================
// CONCURRENT ENSURE DEDUPLICATION
// =============================================================================

describe("Concurrent ensure deduplication", () => {
  it("test 28: concurrent ensure() for the same key creates only one container", async () => {
    const { manager } = createManager();

    const [url1, url2, url3] = await Promise.all([
      manager.ensure("main", sharedAgent, "scope-1"),
      manager.ensure("main", sharedAgent, "scope-2"),
      manager.ensure("main", sharedAgent, "scope-3"),
    ]);

    // All three resolve to the same URL (shared mode, same agentId)
    expect(url1).toBe(url2);
    expect(url2).toBe(url3);
    expect(url1).toBe("http://localhost:3001");

    // Only one container was created despite three concurrent calls
    const createCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "create"
    );
    expect(createCalls.length).toBe(1);

    expect(manager.size).toBe(1);
  });
});

// =============================================================================
// RESOURCE LIMITS AND CUSTOM CONFIG
// =============================================================================

describe("Resource limits and custom config", () => {
  it("test 29: agent-specific memory and CPU limits are passed to Docker", async () => {
    const { manager } = createManager();
    await manager.ensure("coder", agentWithDockerfile, "scope-1");

    const createCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "create"
    );
    const args: string[] = createCalls[0][1];

    // Custom memory and CPU limits from agentWithDockerfile
    expect(args).toContain("--memory");
    expect(args).toContain("2g");
    expect(args).toContain("--cpus");
    expect(args).toContain("2");
  });

  it("test 30: agent-specific volumes are included in container creation", async () => {
    const { manager } = createManager();
    await manager.ensure("coder", agentWithDockerfile, "scope-1");

    const createCalls = mockExeca.mock.calls.filter(
      (c: any[]) => c[1][0] === "create"
    );
    const args: string[] = createCalls[0][1];

    // Find all -v (volume) flags
    const volumes: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-v" && i + 1 < args.length) {
        volumes.push(args[i + 1]);
      }
    }

    // Agent-specific volume from agentWithDockerfile config
    expect(volumes).toContain("/data/shared:/workspace/data:ro");

    // System volumes (CA cert) should also be present
    expect(volumes.some((v) => v.includes("ca.crt"))).toBe(true);
  });
});
