/**
 * E2E tests for Docker container management.
 *
 * These tests hit REAL Docker — zero mocks, zero fakes.
 * Requires Docker to be running on the host machine.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { DockerClient } from "../../src/containers/docker.js";
import { PortAllocator } from "../../src/containers/ports.js";
import type { ContainersConfig } from "../../src/containers/types.js";
import type { AgentConfig } from "../../src/types.js";

// ── Constants ────────────────────────────────────────────────────────

const TEST_LABEL = "stockade-test";
const TEST_NETWORK = "stockade-test-net";
const TEST_IMAGE = "stockade-e2e-test:latest";
const PORT_RANGE_START = 19100;
const PORT_RANGE_END = 19199;

// Temp directory for Dockerfile and test artifacts
const TEMP_DIR = resolve(tmpdir(), "stockade-e2e-test");

// Inline Dockerfile: minimal node HTTP server responding to /health and /run
const TEST_DOCKERFILE_CONTENT = `FROM node:22-slim
WORKDIR /app
RUN echo 'const http = require("http"); \\
const PORT = process.env.PORT || 3001; \\
const WORKER_ID = process.env.WORKER_ID || "test-worker"; \\
const server = http.createServer((req, res) => { \\
  if (req.method === "GET" && req.url === "/health") { \\
    res.writeHead(200, { "Content-Type": "application/json" }); \\
    res.end(JSON.stringify({ ok: true, workerId: WORKER_ID })); \\
  } else if (req.method === "POST" && req.url === "/run") { \\
    let body = ""; \\
    req.on("data", chunk => body += chunk); \\
    req.on("end", () => { \\
      res.writeHead(200, { "Content-Type": "application/json" }); \\
      res.end(JSON.stringify({ result: "echo", sessionId: "test-123" })); \\
    }); \\
  } else { \\
    res.writeHead(404); \\
    res.end("Not found"); \\
  } \\
}); \\
server.listen(PORT, "0.0.0.0", () => console.log("listening on " + PORT));' > server.js
EXPOSE 3001
CMD ["node", "server.js"]
`;

// ── Helpers ──────────────────────────────────────────────────────────

/** Check if Docker daemon is reachable */
async function isDockerAvailable(): Promise<boolean> {
  try {
    const { execa } = await import("execa");
    await execa("docker", ["info"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a Docker bridge network WITHOUT --internal.
 *
 * DockerClient.createNetwork() uses --internal which prevents
 * port-forwarding from the host. For e2e tests that need to reach
 * containers via localhost, we create a normal bridge network.
 */
async function createExternalNetwork(name: string): Promise<void> {
  const { execa } = await import("execa");
  await execa("docker", ["network", "create", "--driver", "bridge", name]);
}

/** Remove a Docker network (best-effort). */
async function removeNetwork(name: string): Promise<void> {
  const { execa } = await import("execa");
  try {
    await execa("docker", ["network", "rm", name]);
  } catch { /* ignore */ }
}

/** Aggressively clean up all test containers, networks, and images */
async function cleanupAll(): Promise<void> {
  const { execa } = await import("execa");

  // Stop and remove all containers with our test label
  try {
    const { stdout } = await execa("docker", [
      "ps", "-a", "-q",
      "--filter", `label=${TEST_LABEL}=true`,
    ]);
    const ids = stdout.trim().split("\n").filter(Boolean);
    for (const id of ids) {
      try { await execa("docker", ["rm", "-f", id]); } catch { /* ignore */ }
    }
  } catch { /* no containers */ }

  // Remove test network
  await removeNetwork(TEST_NETWORK);

  // Remove test image
  try { await execa("docker", ["rmi", "-f", TEST_IMAGE]); } catch { /* ignore */ }

  // Remove temp dir
  try { rmSync(TEMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Wait for HTTP endpoint to be reachable, with retries */
async function waitForHttp(
  url: string,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return res;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(
    `HTTP endpoint ${url} not reachable after ${timeoutMs}ms: ${lastError}`
  );
}

// ── Test suite ───────────────────────────────────────────────────────

let dockerAvailable = false;

beforeAll(async () => {
  dockerAvailable = await isDockerAvailable();
}, 15_000);

describe("Docker E2E (real Docker)", { timeout: 120_000 }, () => {
  const docker = new DockerClient();
  let skipReason = "";

  beforeAll(async () => {
    if (!await isDockerAvailable()) {
      skipReason = "Docker is not available - skipping all e2e tests";
      return;
    }

    // Clean up any leftovers from previous runs
    await cleanupAll();

    // Create temp directory and write Dockerfile
    mkdirSync(TEMP_DIR, { recursive: true });
    writeFileSync(resolve(TEMP_DIR, "Dockerfile"), TEST_DOCKERFILE_CONTENT);
  }, 30_000);

  afterAll(async () => {
    await cleanupAll();
  }, 60_000);

  // ── Test 1: Network creation ──────────────────────────────────────

  it("DockerClient.networkExists + createNetwork", async ({ skip }) => {
    if (skipReason) skip(skipReason);

    // Should not exist initially (cleaned up in beforeAll)
    const existsBefore = await docker.networkExists(TEST_NETWORK);
    expect(existsBefore).toBe(false);

    // Create using the real DockerClient (creates --internal network)
    await docker.createNetwork(TEST_NETWORK);

    // Should exist now
    const existsAfter = await docker.networkExists(TEST_NETWORK);
    expect(existsAfter).toBe(true);

    // Clean up
    await removeNetwork(TEST_NETWORK);

    const existsGone = await docker.networkExists(TEST_NETWORK);
    expect(existsGone).toBe(false);
  });

  // ── Test 2: Build test image ──────────────────────────────────────

  it("Build test image and verify imageExists()", async ({ skip }) => {
    if (skipReason) skip(skipReason);

    // Image should not exist (cleaned in beforeAll)
    const existsBefore = await docker.imageExists(TEST_IMAGE);
    expect(existsBefore).toBe(false);

    // Build
    await docker.buildImage({
      dockerfile: resolve(TEMP_DIR, "Dockerfile"),
      tag: TEST_IMAGE,
      context: TEMP_DIR,
    });

    // Should exist now
    const existsAfter = await docker.imageExists(TEST_IMAGE);
    expect(existsAfter).toBe(true);
  });

  // ── Test 3: Full container lifecycle ──────────────────────────────

  it("Full container lifecycle: create -> start -> health check -> stop -> remove", async ({ skip }) => {
    if (skipReason) skip(skipReason);

    const containerName = "e2e-lifecycle-test";
    const port = PORT_RANGE_START;

    // Create a non-internal network so port-forwarding to the host works
    await createExternalNetwork(TEST_NETWORK);

    try {
      // Create container
      const containerId = await docker.createContainer({
        image: TEST_IMAGE,
        name: containerName,
        network: TEST_NETWORK,
        ports: { "3001/tcp": String(port) },
        env: { PORT: "3001", WORKER_ID: "lifecycle-test" },
        volumes: [],
        labels: { [TEST_LABEL]: "true" },
      });

      expect(containerId).toBeTruthy();
      expect(typeof containerId).toBe("string");

      // Inspect before start
      const preStart = await docker.inspectContainer(containerId);
      expect(preStart).not.toBeNull();
      expect(preStart!.state.running).toBe(false);

      // Start container
      await docker.startContainer(containerId);

      // Verify running
      const postStart = await docker.inspectContainer(containerId);
      expect(postStart!.state.running).toBe(true);

      // Wait for HTTP health endpoint
      const res = await waitForHttp(`http://localhost:${port}/health`);
      const body = await res.json();
      expect(body).toEqual({ ok: true, workerId: "lifecycle-test" });

      // Stop container
      await docker.stopContainer(containerId, 5);

      const postStop = await docker.inspectContainer(containerId);
      expect(postStop!.state.running).toBe(false);

      // Remove container
      await docker.removeContainer(containerId);

      const postRemove = await docker.inspectContainer(containerId);
      expect(postRemove).toBeNull();
    } finally {
      const { execa } = await import("execa");
      try { await execa("docker", ["rm", "-f", containerName]); } catch { /* ok */ }
      await removeNetwork(TEST_NETWORK);
    }
  });

  // ── Test 4: PortAllocator integration ─────────────────────────────

  it("PortAllocator integration - allocate port, bind container, verify HTTP, release", async ({ skip }) => {
    if (skipReason) skip(skipReason);

    const allocator = new PortAllocator([PORT_RANGE_START, PORT_RANGE_END]);
    const port = allocator.allocate();

    expect(port).toBe(PORT_RANGE_START);
    expect(allocator.isAvailable(port)).toBe(false);

    await createExternalNetwork(TEST_NETWORK);

    const containerName = "e2e-port-alloc-test";
    try {
      const containerId = await docker.createContainer({
        image: TEST_IMAGE,
        name: containerName,
        network: TEST_NETWORK,
        ports: { "3001/tcp": String(port) },
        env: { PORT: "3001", WORKER_ID: "port-alloc-test" },
        volumes: [],
        labels: { [TEST_LABEL]: "true" },
      });

      await docker.startContainer(containerId);

      // Verify HTTP connectivity on allocated port
      const res = await waitForHttp(`http://localhost:${port}/health`);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // Teardown
      await docker.stopContainer(containerId, 5);
      await docker.removeContainer(containerId);

      // Release port and verify
      allocator.release(port);
      expect(allocator.isAvailable(port)).toBe(true);
    } finally {
      const { execa } = await import("execa");
      try { await execa("docker", ["rm", "-f", containerName]); } catch { /* ok */ }
      await removeNetwork(TEST_NETWORK);
    }
  });

  // ── Test 5: ContainerManager.ensure() equivalent ──────────────────

  it("ContainerManager lifecycle - ensure, reuse, shutdownAll", async ({ skip }) => {
    if (skipReason) skip(skipReason);

    await createExternalNetwork(TEST_NETWORK);

    const port = PORT_RANGE_START + 10;
    const allocator = new PortAllocator([port, port + 10]);

    try {
      // === Phase 1: First "ensure" — create + start + health check ===
      const allocatedPort = allocator.allocate();
      const containerName = `e2e-manager-test-${allocatedPort}`;

      const containerId = await docker.createContainer({
        image: TEST_IMAGE,
        name: containerName,
        network: TEST_NETWORK,
        ports: { "3001/tcp": String(allocatedPort) },
        env: { PORT: "3001", WORKER_ID: "manager-test" },
        volumes: [],
        labels: {
          [TEST_LABEL]: "true",
          "stockade": "true",
          "agent-id": "test-agent",
          "container-key": "test-agent",
        },
        memory: "256m",
        cpus: 0.5,
      });

      await docker.startContainer(containerId);

      // Health check
      const url = `http://localhost:${allocatedPort}`;
      const res = await waitForHttp(`${url}/health`);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // Verify labels set correctly
      const info = await docker.inspectContainer(containerId);
      expect(info).not.toBeNull();
      expect(info!.state.running).toBe(true);
      expect(info!.labels["agent-id"]).toBe("test-agent");

      // === Phase 2: "ensure again" — container still running, reuse ===
      const info2 = await docker.inspectContainer(containerId);
      expect(info2!.state.running).toBe(true);
      const res2 = await waitForHttp(`${url}/health`);
      const body2 = await res2.json();
      expect(body2.ok).toBe(true);

      // === Phase 3: "shutdownAll" — stop + remove + release port ===
      await docker.stopContainer(containerId, 5);
      await docker.removeContainer(containerId);
      allocator.release(allocatedPort);

      // Verify container is gone
      const gone = await docker.inspectContainer(containerId);
      expect(gone).toBeNull();

      // Verify port is available again
      expect(allocator.isAvailable(allocatedPort)).toBe(true);
    } finally {
      const { execa } = await import("execa");
      try {
        const { stdout } = await execa("docker", [
          "ps", "-a", "-q", "--filter", `label=${TEST_LABEL}=true`,
        ]);
        for (const id of stdout.trim().split("\n").filter(Boolean)) {
          try { await execa("docker", ["rm", "-f", id]); } catch { /* ok */ }
        }
      } catch { /* ok */ }
      await removeNetwork(TEST_NETWORK);
    }
  });

  // ── Test 6: Container environment variables ───────────────────────

  it("Container environment variables - set and verify via exec", async ({ skip }) => {
    if (skipReason) skip(skipReason);

    const { execa } = await import("execa");

    await createExternalNetwork(TEST_NETWORK);

    const containerName = "e2e-env-vars-test";
    const port = PORT_RANGE_START + 20;

    try {
      const containerId = await docker.createContainer({
        image: TEST_IMAGE,
        name: containerName,
        network: TEST_NETWORK,
        ports: { "3001/tcp": String(port) },
        env: {
          PORT: "3001",
          WORKER_ID: "env-test",
          CUSTOM_VAR_1: "hello-world",
          CUSTOM_VAR_2: "stockade-e2e",
          API_URL: "https://api.example.com",
        },
        volumes: [],
        labels: { [TEST_LABEL]: "true" },
      });

      await docker.startContainer(containerId);
      await waitForHttp(`http://localhost:${port}/health`);

      // Exec into the container to verify environment variables
      const { stdout: var1 } = await execa("docker", [
        "exec", containerId, "printenv", "CUSTOM_VAR_1",
      ]);
      expect(var1.trim()).toBe("hello-world");

      const { stdout: var2 } = await execa("docker", [
        "exec", containerId, "printenv", "CUSTOM_VAR_2",
      ]);
      expect(var2.trim()).toBe("stockade-e2e");

      const { stdout: apiUrl } = await execa("docker", [
        "exec", containerId, "printenv", "API_URL",
      ]);
      expect(apiUrl.trim()).toBe("https://api.example.com");

      const { stdout: workerId } = await execa("docker", [
        "exec", containerId, "printenv", "WORKER_ID",
      ]);
      expect(workerId.trim()).toBe("env-test");

      // Clean up
      await docker.stopContainer(containerId, 5);
      await docker.removeContainer(containerId);
    } finally {
      try { await execa("docker", ["rm", "-f", containerName]); } catch { /* ok */ }
      await removeNetwork(TEST_NETWORK);
    }
  });

  // ── Test 7: Container auto-cleanup on external kill ───────────────

  it("Container auto-cleanup - detect externally killed container and restart", async ({ skip }) => {
    if (skipReason) skip(skipReason);

    const { execa } = await import("execa");

    await createExternalNetwork(TEST_NETWORK);

    const containerName = "e2e-auto-cleanup-test";
    const port = PORT_RANGE_START + 30;

    try {
      // Start first container
      const containerId = await docker.createContainer({
        image: TEST_IMAGE,
        name: containerName,
        network: TEST_NETWORK,
        ports: { "3001/tcp": String(port) },
        env: { PORT: "3001", WORKER_ID: "auto-cleanup-test" },
        volumes: [],
        labels: {
          [TEST_LABEL]: "true",
          "stockade": "true",
          "agent-id": "auto-cleanup-agent",
          "container-key": "auto-cleanup-agent",
        },
      });

      await docker.startContainer(containerId);
      await waitForHttp(`http://localhost:${port}/health`);

      // Verify it's running
      const running = await docker.inspectContainer(containerId);
      expect(running!.state.running).toBe(true);

      // Externally kill the container (simulating unexpected death)
      await execa("docker", ["kill", containerId]);

      // Wait for Docker to register the kill
      await new Promise((r) => setTimeout(r, 1500));

      // Verify the container is dead
      const dead = await docker.inspectContainer(containerId);
      expect(dead!.state.running).toBe(false);

      // Health check should fail
      let healthOk = false;
      try {
        const res = await fetch(`http://localhost:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        healthOk = res.ok;
      } catch {
        healthOk = false;
      }
      expect(healthOk).toBe(false);

      // Clean up the dead container (like ContainerManager.teardown does)
      await docker.removeContainer(containerId);

      // "Restart" — create a new container on the same port (like ensure() would)
      const newContainerName = "e2e-auto-cleanup-test-2";
      const newContainerId = await docker.createContainer({
        image: TEST_IMAGE,
        name: newContainerName,
        network: TEST_NETWORK,
        ports: { "3001/tcp": String(port) },
        env: { PORT: "3001", WORKER_ID: "auto-cleanup-restarted" },
        volumes: [],
        labels: {
          [TEST_LABEL]: "true",
          "stockade": "true",
          "agent-id": "auto-cleanup-agent",
          "container-key": "auto-cleanup-agent",
        },
      });

      await docker.startContainer(newContainerId);

      // New container should be healthy
      const res = await waitForHttp(`http://localhost:${port}/health`);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.workerId).toBe("auto-cleanup-restarted");

      // Verify new container is running
      const restarted = await docker.inspectContainer(newContainerId);
      expect(restarted!.state.running).toBe(true);

      // Cleanup
      await docker.stopContainer(newContainerId, 5);
      await docker.removeContainer(newContainerId);
    } finally {
      try { await execa("docker", ["rm", "-f", containerName]); } catch { /* ok */ }
      try { await execa("docker", ["rm", "-f", "e2e-auto-cleanup-test-2"]); } catch { /* ok */ }
      await removeNetwork(TEST_NETWORK);
    }
  });

  // ── Test 8: Named volume chown ────────────────────────────────────

  it("Named volume chown — Docker creates volumes as root; runEphemeral chowns to 1000:1000", async ({ skip }) => {
    if (skipReason) skip(skipReason);

    const { execa } = await import("execa");
    const VOLUME_NAME = "stockade-e2e-chown-test";

    try {
      // Docker creates named volumes owned by root (0:0)
      await execa("docker", ["volume", "create", VOLUME_NAME]);

      const { stdout: before } = await execa("docker", [
        "run", "--rm", "-v", `${VOLUME_NAME}:/chown_vol_0`,
        "alpine", "stat", "-c", "%u:%g", "/chown_vol_0",
      ]);
      expect(before.trim()).toBe("0:0");

      // DockerClient.runEphemeral() is what ContainerManager.chownNamedVolumes() calls
      await docker.runEphemeral([
        "-v", `${VOLUME_NAME}:/chown_vol_0`,
        "alpine", "sh", "-c", "chown -R 1000:1000 /chown_vol_0",
      ]);

      // Volume should now be 1000:1000
      const { stdout: after } = await execa("docker", [
        "run", "--rm", "-v", `${VOLUME_NAME}:/chown_vol_0`,
        "alpine", "stat", "-c", "%u:%g", "/chown_vol_0",
      ]);
      expect(after.trim()).toBe("1000:1000");

      // A non-root user (UID 1000) should now be able to write to it
      const { stdout: writeResult } = await execa("docker", [
        "run", "--rm", "--user", "1000:1000",
        "-v", `${VOLUME_NAME}:/chown_vol_0`,
        "alpine", "sh", "-c", "touch /chown_vol_0/canary && echo ok",
      ]);
      expect(writeResult.trim()).toBe("ok");
    } finally {
      try { await execa("docker", ["volume", "rm", "-f", VOLUME_NAME]); } catch { /* ok */ }
    }
  });
});
