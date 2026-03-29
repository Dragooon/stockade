import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { ContainersConfig } from "../../src/containers/types.js";
import type { AgentConfig } from "../../src/types.js";
import { provisionContainer } from "../../src/containers/provision.js";

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const tmpBase = resolve(
  tmpdir(),
  `provision-test-${randomBytes(4).toString("hex")}`
);

const containersConfig: ContainersConfig = {
  network: "agent-net",
  proxy_host: "host.docker.internal",
  port_range: [3001, 3099],
  base_dockerfile: "./packages/worker/Dockerfile",
  build_context: ".",
  health_check: { interval_ms: 500, timeout_ms: 30000, retries: 3 },
  defaults: { memory: "1g", cpus: 1.0 },
  max_age_hours: 0,
  session_idle_minutes: 30,
  proxy_ca_cert: "./data/proxy/ca.crt",
};

const agentConfig: AgentConfig = {
  model: "sonnet",
  system: "You are helpful.",
  tools: ["Bash"],
  sandboxed: true,
  credentials: ["AgentVault/Anthropic/api-key", "AgentVault/GitHub/token"],
  store_keys: ["AgentVault/*"],
};

const agentWithVolumes: AgentConfig = {
  ...agentConfig,
  container: {
    isolation: "shared" as const,
    volumes: ["/data/shared:/data:ro"],
  },
};

describe("provisionContainer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("issues gateway token and returns env + volumes", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: "apw-main-abc123",
        expiresAt: Date.now() + 86400000,
      }),
    });

    const result = await provisionContainer(
      "main",
      agentConfig,
      containersConfig,
      "http://localhost:10256",
      tmpBase,
      3001
    );

    // Token fetch was called correctly
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:10256/token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.agentId).toBe("main");
    expect(body.credentials).toEqual([
      "AgentVault/Anthropic/api-key",
      "AgentVault/GitHub/token",
    ]);
    expect(body.storeKeys).toEqual(["AgentVault/*"]);

    // Check env — proxy vars present when proxy responds
    expect(result.env.PORT).toBe("3001");
    expect(result.env.WORKER_ID).toBe("main");
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.env.HTTP_PROXY).toBe(
      "http://host.docker.internal:10255"
    );
    expect(result.env.APW_TOKEN).toBe("apw-main-abc123");
    expect(result.env.NODE_EXTRA_CA_CERTS).toBe("/certs/proxy-ca.crt");

    // Mock credentials are always mounted
    const credsVolume = result.volumes.find((v: string) => v.includes(".credentials.json"));
    expect(credsVolume).toBeDefined();
    expect(credsVolume).toContain(":ro");

    // Gateway token is returned
    expect(result.gatewayToken).toBe("apw-main-abc123");
  });

  it("writes mock credentials, not real ones", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: "apw-main-mock",
        expiresAt: Date.now() + 86400000,
      }),
    });

    const result = await provisionContainer(
      "main",
      agentConfig,
      containersConfig,
      "http://localhost:10256",
      tmpBase,
      3001
    );

    // Find the mock credentials file on disk
    const credsVolume = result.volumes.find((v: string) => v.includes(".credentials.json"))!;
    // On Windows the host path contains "C:" so split on ":/home" or ":/certs" boundary
    const hostPath = credsVolume.slice(0, credsVolume.indexOf(":/home"));
    const { readFileSync } = await import("node:fs");
    const content = JSON.parse(readFileSync(hostPath, "utf-8"));

    // Should be a stub, not a real token
    expect(content.claudeAiOauth.accessToken).toBe("sk-ant-stub-container-proxy-handles-auth");
  });

  it("includes agent-specific volumes", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: "apw-main-xyz",
        expiresAt: Date.now() + 86400000,
      }),
    });

    const result = await provisionContainer(
      "main",
      agentWithVolumes,
      containersConfig,
      "http://localhost:10256",
      tmpBase,
      3001
    );

    expect(result.volumes).toContain("/data/shared:/data:ro");
  });

  it("degrades gracefully when proxy returns error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const result = await provisionContainer(
      "main",
      agentConfig,
      containersConfig,
      "http://localhost:10256",
      tmpBase,
      3001
    );

    // Minimal env — no proxy vars
    expect(result.env.PORT).toBe("3001");
    expect(result.env.WORKER_ID).toBe("main");
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.env.HTTP_PROXY).toBeUndefined();
    expect(result.env.APW_TOKEN).toBeUndefined();
    expect(result.gatewayToken).toBe("");
    // Mock credentials are always mounted regardless of proxy availability
    const credsVolume = result.volumes.find((v: string) => v.includes(".credentials.json"));
    expect(credsVolume).toBeDefined();
  });

  it("degrades gracefully when proxy is unreachable", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await provisionContainer(
      "main",
      agentConfig,
      containersConfig,
      "http://localhost:10256",
      tmpBase,
      3001
    );

    // Minimal env — no proxy vars
    expect(result.env.PORT).toBe("3001");
    expect(result.env.WORKER_ID).toBe("main");
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.env.HTTP_PROXY).toBeUndefined();
    expect(result.gatewayToken).toBe("");
  });

  it("cleanup revokes token and removes temp dir", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: "apw-main-cleanup",
        expiresAt: Date.now() + 86400000,
      }),
    });

    const result = await provisionContainer(
      "main",
      agentConfig,
      containersConfig,
      "http://localhost:10256",
      tmpBase,
      3001
    );

    // Container dir should exist
    const containerDir = resolve(tmpBase, "containers", "main");
    expect(existsSync(containerDir)).toBe(true);

    // Reset fetch mock to track cleanup call
    mockFetch.mockResolvedValue({ ok: true });

    await result.cleanup();

    // Should have called DELETE on the token
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:10256/token/apw-main-cleanup",
      { method: "DELETE" }
    );

    // Temp dir should be cleaned up
    expect(existsSync(containerDir)).toBe(false);
  });

  it("cleanup is best-effort on token revocation failure", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "apw-main-fail",
          expiresAt: Date.now() + 86400000,
        }),
      })
      .mockRejectedValueOnce(new Error("network down"));

    const result = await provisionContainer(
      "main",
      agentConfig,
      containersConfig,
      "http://localhost:10256",
      tmpBase,
      3001
    );

    // Should not throw even if revocation fails
    await expect(result.cleanup()).resolves.toBeUndefined();
  });
});
