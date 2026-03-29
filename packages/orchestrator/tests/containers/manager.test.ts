import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContainersConfig } from "../../src/containers/types.js";
import type { AgentConfig } from "../../src/types.js";

// Mock provisionContainer
vi.mock("../../src/containers/provision.js", () => ({
  provisionContainer: vi.fn(),
}));

// Mock images
vi.mock("../../src/containers/images.js", () => ({
  resolveDockerfile: vi.fn().mockReturnValue("/path/to/Dockerfile"),
  ensureImage: vi.fn().mockResolvedValue("stockade/worker"),
}));

// Mock fetch for health checks
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { provisionContainer } = await import(
  "../../src/containers/provision.js"
);
const { ContainerManager } = await import(
  "../../src/containers/manager.js"
);

function makeDocker() {
  return {
    networkExists: vi.fn().mockResolvedValue(true),
    createNetwork: vi.fn().mockResolvedValue(undefined),
    createContainer: vi.fn().mockResolvedValue("container-abc123"),
    startContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    inspectContainer: vi.fn().mockResolvedValue(null),
    listContainers: vi.fn().mockResolvedValue([]),
    imageExists: vi.fn().mockResolvedValue(true),
    imageCreatedAt: vi.fn().mockResolvedValue(Date.now()),
    buildImage: vi.fn().mockResolvedValue(undefined),
  };
}

const containersConfig: ContainersConfig = {
  network: "agent-net",
  proxy_host: "host.docker.internal",
  port_range: [3001, 3099],
  base_dockerfile: "./packages/worker/Dockerfile",
  build_context: ".",
  health_check: { interval_ms: 10, timeout_ms: 100, retries: 3 },
  defaults: { memory: "1g", cpus: 1.0 },
  max_age_hours: 0,
  session_idle_minutes: 30,
  proxy_ca_cert: "./data/proxy/ca.crt",
};

const sharedAgent: AgentConfig = {
  model: "sonnet",
  system: "test",
  tools: ["Bash"],
  sandboxed: true,
  credentials: ["key1"],
};

const sessionAgent: AgentConfig = {
  model: "sonnet",
  system: "test",
  tools: ["Bash"],
  sandboxed: true,
  credentials: ["key1"],
  container: { isolation: "session" as const },
};

describe("ContainerManager", () => {
  let docker: ReturnType<typeof makeDocker>;
  let manager: InstanceType<typeof ContainerManager>;
  const mockCleanup = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    docker = makeDocker();
    manager = new ContainerManager(
      docker as any,
      containersConfig,
      "http://localhost:10256",
      "/tmp/test-data"
    );

    // Default provision mock
    (provisionContainer as any).mockResolvedValue({
      env: { PORT: "3001" },
      volumes: [],
      gatewayToken: "apw-test-token",
      cleanup: mockCleanup,
    });

    // Default health check mock (healthy)
    mockFetch.mockResolvedValue({ ok: true });
  });

  describe("ensure — shared mode", () => {
    it("starts a new container on first call", async () => {
      const url = await manager.ensure("main", sharedAgent, "scope-alice");

      expect(url).toBe("http://localhost:3001");
      expect(docker.createContainer).toHaveBeenCalledTimes(1);
      expect(docker.startContainer).toHaveBeenCalledWith("container-abc123");
      expect(manager.size).toBe(1);

      // Check labels
      const opts = docker.createContainer.mock.calls[0][0];
      expect(opts.labels["stockade"]).toBe("true");
      expect(opts.labels["agent-id"]).toBe("main");
      expect(opts.labels.isolation).toBe("shared");
    });

    it("reuses existing container for different scopes (shared)", async () => {
      const url1 = await manager.ensure("main", sharedAgent, "scope-alice");
      const url2 = await manager.ensure("main", sharedAgent, "scope-bob");

      expect(url1).toBe(url2);
      expect(docker.createContainer).toHaveBeenCalledTimes(1);
      expect(manager.size).toBe(1);
    });

    it("restarts dead container", async () => {
      await manager.ensure("main", sharedAgent, "scope-alice");

      // Simulate health check failure
      mockFetch.mockResolvedValueOnce({ ok: false });

      // Second provision
      (provisionContainer as any).mockResolvedValue({
        env: { PORT: "3001" },
        volumes: [],
        gatewayToken: "apw-test-token-2",
        cleanup: mockCleanup,
      });
      docker.createContainer.mockResolvedValue("container-def456");

      const url2 = await manager.ensure("main", sharedAgent, "scope-alice");

      // Should have torn down old + created new
      expect(docker.stopContainer).toHaveBeenCalled();
      expect(docker.removeContainer).toHaveBeenCalled();
      expect(docker.createContainer).toHaveBeenCalledTimes(2);
      // Port 3001 was released by teardown and re-allocated
      expect(url2).toBe("http://localhost:3001");
    });
  });

  describe("ensure — session-isolated mode", () => {
    it("creates separate containers for different scopes", async () => {
      docker.createContainer
        .mockResolvedValueOnce("container-1")
        .mockResolvedValueOnce("container-2");

      (provisionContainer as any)
        .mockResolvedValueOnce({
          env: { PORT: "3001" },
          volumes: [],
          gatewayToken: "tok-1",
          cleanup: mockCleanup,
        })
        .mockResolvedValueOnce({
          env: { PORT: "3002" },
          volumes: [],
          gatewayToken: "tok-2",
          cleanup: mockCleanup,
        });

      const url1 = await manager.ensure(
        "sandbox",
        sessionAgent,
        "discord:123:alice"
      );
      const url2 = await manager.ensure(
        "sandbox",
        sessionAgent,
        "discord:456:bob"
      );

      expect(url1).not.toBe(url2);
      expect(docker.createContainer).toHaveBeenCalledTimes(2);
      expect(manager.size).toBe(2);

      // Check isolation label
      const opts = docker.createContainer.mock.calls[0][0];
      expect(opts.labels.isolation).toBe("session");
    });

    it("reuses container for same scope", async () => {
      const url1 = await manager.ensure(
        "sandbox",
        sessionAgent,
        "discord:123:alice"
      );
      const url2 = await manager.ensure(
        "sandbox",
        sessionAgent,
        "discord:123:alice"
      );

      expect(url1).toBe(url2);
      expect(docker.createContainer).toHaveBeenCalledTimes(1);
    });
  });

  describe("teardown", () => {
    it("stops, removes container, releases port, runs cleanup", async () => {
      await manager.ensure("main", sharedAgent, "scope-1");
      expect(manager.size).toBe(1);

      await manager.teardown("main");

      expect(docker.stopContainer).toHaveBeenCalledWith(
        "container-abc123",
        5
      );
      expect(docker.removeContainer).toHaveBeenCalledWith(
        "container-abc123"
      );
      expect(mockCleanup).toHaveBeenCalled();
      expect(manager.size).toBe(0);
    });

    it("no-op for unknown key", async () => {
      await manager.teardown("nonexistent");
      expect(docker.stopContainer).not.toHaveBeenCalled();
    });
  });

  describe("teardownScope", () => {
    it("tears down only session-isolated containers for the given scope", async () => {
      docker.createContainer
        .mockResolvedValueOnce("c-shared")
        .mockResolvedValueOnce("c-session-1")
        .mockResolvedValueOnce("c-session-2");

      (provisionContainer as any)
        .mockResolvedValueOnce({
          env: { PORT: "3001" },
          volumes: [],
          gatewayToken: "t1",
          cleanup: mockCleanup,
        })
        .mockResolvedValueOnce({
          env: { PORT: "3002" },
          volumes: [],
          gatewayToken: "t2",
          cleanup: mockCleanup,
        })
        .mockResolvedValueOnce({
          env: { PORT: "3003" },
          volumes: [],
          gatewayToken: "t3",
          cleanup: mockCleanup,
        });

      // Shared container for "main"
      await manager.ensure("main", sharedAgent, "discord:123:alice");
      // Session container for "sandbox" scope alice
      await manager.ensure("sandbox", sessionAgent, "discord:123:alice");
      // Session container for "sandbox" scope bob
      await manager.ensure("sandbox", sessionAgent, "discord:456:bob");

      expect(manager.size).toBe(3);

      // Tear down alice's scope — should only remove alice's session container
      await manager.teardownScope("discord:123:alice");

      // Shared container + bob's container remain
      expect(manager.size).toBe(2);
    });
  });

  describe("shutdownAll", () => {
    it("tears down everything", async () => {
      docker.createContainer
        .mockResolvedValueOnce("c1")
        .mockResolvedValueOnce("c2");

      (provisionContainer as any)
        .mockResolvedValueOnce({
          env: { PORT: "3001" },
          volumes: [],
          gatewayToken: "t1",
          cleanup: mockCleanup,
        })
        .mockResolvedValueOnce({
          env: { PORT: "3002" },
          volumes: [],
          gatewayToken: "t2",
          cleanup: mockCleanup,
        });

      await manager.ensure("main", sharedAgent, "s1");
      await manager.ensure("sandbox", sessionAgent, "s2");
      expect(manager.size).toBe(2);

      await manager.shutdownAll();
      expect(manager.size).toBe(0);
      expect(docker.stopContainer).toHaveBeenCalledTimes(2);
    });
  });

  describe("getUrl", () => {
    it("returns URL for running container", async () => {
      await manager.ensure("main", sharedAgent, "scope-1");
      const url = manager.getUrl("main", sharedAgent, "scope-1");
      expect(url).toBe("http://localhost:3001");
    });

    it("returns null for non-running container", () => {
      expect(manager.getUrl("main", sharedAgent, "scope-1")).toBeNull();
    });
  });

  describe("cleanupIdle", () => {
    it("tears down session containers past idle timeout", async () => {
      // Use a 1-minute idle timeout for testing
      const shortConfig: ContainersConfig = {
        ...containersConfig,
        session_idle_minutes: 1,
      };
      const mgr = new ContainerManager(
        docker as any,
        shortConfig,
        "http://localhost:10256",
        "/tmp/test-data"
      );

      (provisionContainer as any).mockResolvedValue({
        env: { PORT: "3001" },
        volumes: [],
        gatewayToken: "t1",
        cleanup: mockCleanup,
      });

      await mgr.ensure("sandbox", sessionAgent, "scope-1");
      expect(mgr.size).toBe(1);

      // Advance time past idle timeout using fake timers
      vi.useFakeTimers();
      vi.advanceTimersByTime(2 * 60_000); // 2 minutes

      await mgr.cleanupIdle();
      expect(mgr.size).toBe(0);
      vi.useRealTimers();
    });

    it("does not tear down shared containers when max_age_hours is 0", async () => {
      await manager.ensure("main", sharedAgent, "scope-1");
      await manager.cleanupIdle();
      // max_age_hours=0 means no auto-cleanup for shared
      expect(manager.size).toBe(1);
    });
  });

  describe("concurrent ensure — deduplication", () => {
    it("concurrent ensure() for the same key creates only one container", async () => {
      const [url1, url2] = await Promise.all([
        manager.ensure("main", sharedAgent, "scope1"),
        manager.ensure("main", sharedAgent, "scope1"),
      ]);

      // Only ONE container should be created
      expect(docker.createContainer).toHaveBeenCalledTimes(1);

      // Both promises should resolve to the same URL
      expect(url1).toBe(url2);
      expect(url1).toBe("http://localhost:3001");
      expect(manager.size).toBe(1);
    });
  });

  describe("health check retries", () => {
    it("succeeds when health check fails N-1 times then succeeds", async () => {
      // Fail twice, then succeed on the third attempt
      mockFetch
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce({ ok: true });

      const url = await manager.ensure("main", sharedAgent, "scope1");

      expect(url).toBe("http://localhost:3001");
      expect(docker.createContainer).toHaveBeenCalledTimes(1);
      expect(docker.startContainer).toHaveBeenCalledTimes(1);
      // fetch was called multiple times for health check retries
      expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("throws when health check fails all retries (timeout)", async () => {
      // Always fail — health check should eventually time out
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(
        manager.ensure("main", sharedAgent, "scope1")
      ).rejects.toThrow(/health check timed out/i);
    });
  });

  describe("cleanupOrphans", () => {
    it("removes containers not tracked in state map", async () => {
      docker.listContainers.mockResolvedValue([
        {
          id: "orphan-1",
          name: "agent-old",
          labels: {
            "stockade": "true",
            "container-key": "old-agent",
          },
          state: "exited",
          ports: "",
        },
      ]);

      await manager.cleanupOrphans();

      expect(docker.stopContainer).toHaveBeenCalledWith("orphan-1", 5);
      expect(docker.removeContainer).toHaveBeenCalledWith("orphan-1");
    });

    it("does not remove containers tracked in state map", async () => {
      await manager.ensure("main", sharedAgent, "scope-1");

      docker.listContainers.mockResolvedValue([
        {
          id: "container-abc123",
          name: "agent-main",
          labels: {
            "stockade": "true",
            "container-key": "main",
          },
          state: "running",
          ports: "3001",
        },
      ]);

      // Reset stop/remove mocks after ensure()
      docker.stopContainer.mockClear();
      docker.removeContainer.mockClear();

      await manager.cleanupOrphans();

      expect(docker.stopContainer).not.toHaveBeenCalled();
      expect(docker.removeContainer).not.toHaveBeenCalled();
    });
  });
});
