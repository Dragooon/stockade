import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { DockerClient } from "./docker.js";
import type { ContainersConfig, ContainerState, ContainerInfo } from "./types.js";
import type { AgentConfig } from "../types.js";
import type { WorkerManager } from "../workers/index.js";
import { PortAllocator } from "./ports.js";
import { provisionContainer, type ProvisionResult } from "./provision.js";
import { resolveDockerfile, ensureImage } from "./images.js";
import { createWorkerLogger } from "../log.js";

/**
 * Manages the lifecycle of Docker containers for sandboxed agents.
 *
 * Shared containers (default): one container per agentId, reused across scopes.
 * Session-isolated containers: one container per scope, keyed by agentId:scopeHash.
 */
export class ContainerManager implements WorkerManager {
  private readonly containers = new Map<string, ContainerState>();
  private readonly cleanups = new Map<string, () => Promise<void>>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly logProcs = new Map<string, ChildProcess>();
  private readonly portAllocator: PortAllocator;

  constructor(
    private readonly docker: DockerClient,
    private readonly config: ContainersConfig,
    private readonly proxyGatewayUrl: string,
    private readonly dataDir: string,
    private readonly logsDir: string,
    private readonly agentsDir?: string,
    private readonly redisUrl?: string,
  ) {
    this.portAllocator = new PortAllocator(config.port_range);
  }

  /**
   * Ensure a container is running for this agent + scope combination.
   * Returns the container URL for dispatching.
   */
  async ensure(
    agentId: string,
    agentConfig: AgentConfig,
    scope: string
  ): Promise<string> {
    const key = this.resolveKey(agentId, agentConfig, scope);

    // Deduplicate concurrent calls for the same key
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const promise = this.ensureImpl(key, agentId, agentConfig, scope);
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async ensureImpl(
    key: string,
    agentId: string,
    agentConfig: AgentConfig,
    scope: string
  ): Promise<string> {
    // Check if already running
    const existing = this.containers.get(key);
    if (existing) {
      // Verify container is still alive
      const alive = await this.checkHealth(key);
      if (alive) {
        existing.lastActivity = Date.now();
        return existing.url;
      }
      // Dead container — clean up and restart
      await this.teardown(key);
    }

    // Resolve Dockerfile and ensure image
    const dockerfilePath = resolveDockerfile(agentConfig, this.config);
    const imageTag = await ensureImage(this.docker, dockerfilePath, this.config);

    // Allocate port
    const port = this.portAllocator.allocate();

    // Provision (gateway token, env, volumes)
    let provision: ProvisionResult;
    try {
      provision = await provisionContainer(
        agentId,
        agentConfig,
        this.config,
        this.proxyGatewayUrl,
        this.dataDir,
        port,
        this.agentsDir,
        this.redisUrl,
      );
    } catch (err) {
      this.portAllocator.release(port);
      throw err;
    }

    // Store cleanup function
    this.cleanups.set(key, provision.cleanup);

    // Chown named volumes so the non-root container user (node, UID 1000) can write to them.
    // Docker creates named volumes owned by root; this is a no-op for root containers or
    // bind mounts, and idempotent when volumes already have correct ownership.
    await this.chownNamedVolumes(provision.volumes, agentConfig.container?.user);

    // Create container
    const containerName = `agent-${key.replace(/[^a-zA-Z0-9-]/g, "-")}`;
    let containerId: string;
    try {
      containerId = await this.docker.createContainer({
        image: imageTag,
        name: containerName,
        network: this.config.network,
        ports: { [`${port}/tcp`]: String(port) },
        env: provision.env,
        volumes: provision.volumes,
        labels: {
          "stockade": "true",
          "agent-id": agentId,
          "container-key": key,
          "host-port": String(port),
          "image-tag": imageTag,
          isolation: agentConfig.container?.isolation ?? "shared",
        },
        memory: agentConfig.container?.memory ?? this.config.defaults.memory,
        cpus: agentConfig.container?.cpus ?? this.config.defaults.cpus,
        user: agentConfig.container?.user,
        addHost:
          this.config.proxy_host === "host.docker.internal"
            ? undefined
            : [`host.docker.internal:${this.config.proxy_host}`],
      });
    } catch (err) {
      this.portAllocator.release(port);
      await provision.cleanup();
      this.cleanups.delete(key);
      throw err;
    }

    // Start container
    await this.docker.startContainer(containerId);

    // Wait for health check
    await this.waitForHealth(port);

    // Stream container logs to <logsDir>/workers/<agentId>.log
    const log = createWorkerLogger(this.logsDir, agentId);
    const logProc = spawn("docker", ["logs", "--follow", containerId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    logProc.stdout?.on("data", (d: Buffer) => log(d.toString().trimEnd()));
    logProc.stderr?.on("data", (d: Buffer) => log(`[stderr] ${d.toString().trimEnd()}`));
    logProc.on("exit", () => this.logProcs.delete(key));
    this.logProcs.set(key, logProc);

    const url = `http://localhost:${port}`;
    const state: ContainerState = {
      containerId,
      key,
      agentId,
      scope: agentConfig.container?.isolation === "session" ? scope : undefined,
      image: imageTag,
      url,
      port,
      gatewayToken: provision.gatewayToken,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.containers.set(key, state);
    return url;
  }

  /**
   * Tear down a container by key.
   */
  async teardown(key: string): Promise<void> {
    const state = this.containers.get(key);
    if (!state) return;

    try {
      await this.docker.stopContainer(state.containerId, 5);
    } catch {
      // Container may already be stopped
    }

    try {
      await this.docker.removeContainer(state.containerId);
    } catch {
      // Best-effort
    }

    this.portAllocator.release(state.port);
    this.containers.delete(key);

    // Stop log follower
    const logProc = this.logProcs.get(key);
    if (logProc) {
      logProc.kill();
      this.logProcs.delete(key);
    }

    // Run provisioning cleanup (revoke token, remove temp files)
    const cleanup = this.cleanups.get(key);
    if (cleanup) {
      await cleanup();
      this.cleanups.delete(key);
    }
  }

  /**
   * Tear down all session-isolated containers for a given scope.
   */
  async teardownScope(scope: string): Promise<void> {
    const keys = [...this.containers.entries()]
      .filter(([, s]) => s.scope === scope)
      .map(([k]) => k);

    await Promise.all(keys.map((k) => this.teardown(k)));
  }

  /**
   * Graceful shutdown: stop and remove all managed containers,
   * run provisioning cleanup callbacks, and clear internal state.
   */
  async shutdownAll(): Promise<void> {
    await this.gracefulShutdown(false);
  }

  /**
   * Graceful shutdown with optional stop-only mode.
   *
   * stopOnly=true  — stops containers without removing them or revoking proxy tokens.
   *                  Used on orchestrator restart so containers can be reconnected.
   * stopOnly=false — stops, removes, and runs cleanup (default).
   */
  async gracefulShutdown(stopOnly: boolean): Promise<void> {
    // Kill all log followers first
    for (const [key, logProc] of this.logProcs) {
      logProc.kill();
      this.logProcs.delete(key);
    }

    const entries = [...this.containers.entries()];
    await Promise.all(
      entries.map(async ([key, state]) => {
        try {
          await this.docker.stopContainer(state.containerId, 10);
        } catch {
          // Container may already be stopped
        }
        if (!stopOnly) {
          try {
            await this.docker.removeContainer(state.containerId);
          } catch {
            // Best-effort
          }
          this.portAllocator.release(state.port);
          const cleanup = this.cleanups.get(key);
          if (cleanup) {
            await cleanup();
            this.cleanups.delete(key);
          }
        }
        // When stopOnly: port stays reserved and cleanup (token revocation) is skipped.
        // The container is left stopped with its proxy token intact for reconnection.
      }),
    );
    this.containers.clear();
  }

  /**
   * WorkerManager: restart the shared container for an agent.
   * The next ensure() call will re-provision it.
   */
  async restart(agentId: string, _agentConfig: AgentConfig): Promise<void> {
    await this.restartContainer(agentId);
  }

  /**
   * WorkerManager: the memory path as seen inside the container is always /workspace/memory.
   */
  resolveMemoryPath(_agentId: string, _agentConfig: AgentConfig): string {
    return "/workspace/memory";
  }

  /**
   * Restart a container by key (agentId for shared, agentId:scopeHash for session).
   * Tears down the running container; the next ensure() call will re-provision it.
   */
  async restartContainer(key: string): Promise<void> {
    console.log(`[containers] Restarting ${key}...`);
    await this.teardown(key);
    console.log(`[containers] ${key} stopped — will re-provision on next request`);
  }

  /**
   * Rebuild the Docker image for an agent, then restart the container.
   * Forces a fresh image build regardless of Dockerfile mtime.
   */
  async rebuildContainer(key: string, agentConfig: AgentConfig): Promise<void> {
    console.log(`[containers] Rebuilding ${key}...`);
    // Tear down the running container first
    await this.teardown(key);
    // Force rebuild the Docker image
    const dockerfilePath = resolveDockerfile(agentConfig, this.config);
    const tag = await ensureImage(this.docker, dockerfilePath, this.config);
    console.log(`[containers] ${key} image rebuilt as ${tag} — will re-provision on next request`);
  }

  /**
   * Get the URL for a running container, or null.
   */
  getUrl(agentId: string, agentConfig: AgentConfig, scope: string): string | null {
    const key = this.resolveKey(agentId, agentConfig, scope);
    return this.containers.get(key)?.url ?? null;
  }

  /**
   * Check if a container is healthy by hitting GET /health.
   */
  async checkHealth(key: string): Promise<boolean> {
    const state = this.containers.get(key);
    if (!state) return false;

    try {
      const res = await fetch(`${state.url}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Clean up idle containers past their TTL.
   */
  async cleanupIdle(): Promise<void> {
    const now = Date.now();

    for (const [key, state] of this.containers) {
      const idleMs = now - state.lastActivity;

      if (state.scope) {
        // Session-isolated: check session_idle_minutes
        if (idleMs > this.config.session_idle_minutes * 60_000) {
          await this.teardown(key);
        }
      } else if (this.config.max_age_hours > 0) {
        // Shared: check max_age_hours
        if (idleMs > this.config.max_age_hours * 3_600_000) {
          await this.teardown(key);
        }
      }
    }
  }

  /**
   * Remove orphaned containers from a previous run.
   *
   * First tries to reconnect containers that were left stopped (or still
   * running) from a previous orchestrator run. Only removes containers that
   * cannot be reconnected (e.g., wrong image version, failed health check).
   */
  async cleanupOrphans(): Promise<void> {
    // Reconnect first — containers left by a graceful stop-only restart
    await this.reconnectRunning();

    const containers = await this.docker.listContainers({
      "stockade": "true",
    });

    for (const c of containers) {
      const key = c.labels["container-key"];
      if (!key || !this.containers.has(key)) {
        try {
          await this.docker.stopContainer(c.id, 5);
        } catch { /* already stopped */ }
        try {
          await this.docker.removeContainer(c.id);
        } catch { /* best effort */ }
      }
    }
  }

  /**
   * Reconnect to containers left from a previous orchestrator run.
   *
   * On restart with stopOnly=true, containers are stopped but not removed.
   * This method restarts them and adds them back to the manager's map so
   * that the next ensure() call reuses them instead of provisioning new ones.
   *
   * Stopped containers are restarted; running ones are verified via health check.
   * Containers that fail to start or pass health checks are left for cleanupOrphans
   * to remove.
   */
  async reconnectRunning(): Promise<void> {
    let candidates: ContainerInfo[];
    try {
      candidates = await this.docker.listContainers({ "stockade": "true" });
    } catch {
      return; // Docker unavailable — skip
    }

    for (const c of candidates) {
      const key = c.labels["container-key"];
      const agentId = c.labels["agent-id"];
      const portStr = c.labels["host-port"];
      const imageTag = c.labels["image-tag"];
      if (!key || !agentId || !portStr || this.containers.has(key)) continue;

      // Skip containers whose image no longer matches the current build.
      // This ensures a docker image rebuild always gets fresh containers.
      if (imageTag) {
        const currentId = await this.docker.imageId(imageTag).catch(() => null);
        if (currentId && c.image && currentId !== c.image) {
          console.log(`[containers] Skipping stale container ${key} (image ${c.image} ≠ current ${currentId})`);
          continue;
        }
      }

      const port = parseInt(portStr, 10);
      if (isNaN(port) || !this.portAllocator.isAvailable(port)) continue;

      const url = `http://localhost:${port}`;

      if (c.state === "running") {
        // Verify it's actually healthy before adding
        try {
          const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
          if (!res.ok) continue;
        } catch {
          continue;
        }
      } else if (c.state === "exited" || c.state === "stopped") {
        // Restart and wait for it to become healthy
        try {
          await this.docker.startContainer(c.id);
          await this.waitForHealth(port);
        } catch {
          console.log(`[containers] Failed to restart stopped container ${key} — will remove`);
          continue;
        }
      } else {
        continue; // created, paused, etc. — skip
      }

      this.portAllocator.reserve(port);

      const state: ContainerState = {
        containerId: c.id,
        key,
        agentId,
        scope: undefined,
        image: "",
        url,
        port,
        // No gatewayToken tracked — container uses its baked-in env var token
        startedAt: Date.now(),
        lastActivity: Date.now(),
      };
      this.containers.set(key, state);

      // Attach log follower
      const log = createWorkerLogger(this.logsDir, agentId);
      const logProc = spawn("docker", ["logs", "--follow", "--since", "0s", c.id], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      logProc.stdout?.on("data", (d: Buffer) => log(d.toString().trimEnd()));
      logProc.stderr?.on("data", (d: Buffer) => log(`[stderr] ${d.toString().trimEnd()}`));
      logProc.on("exit", () => this.logProcs.delete(key));
      this.logProcs.set(key, logProc);

      console.log(`[containers] Reconnected ${c.state} container ${key} on port ${port}`);
    }
  }

  /** Number of running containers */
  get size(): number {
    return this.containers.size;
  }

  // ── Private ──

  /**
   * Chown named Docker volumes to the UID/GID used by the container.
   * Docker creates named volumes owned by root; the default container user
   * (node, UID 1000) cannot write to them without this step.
   * Runs once per provision via a short-lived Alpine container.
   */
  private async chownNamedVolumes(
    volumes: string[],
    containerUser: string | undefined,
  ): Promise<void> {
    if (containerUser === "root") return; // root can write to root-owned volumes

    const namedVolumes = volumes.filter((v) => {
      const hostPart = v.split(":")[0];
      // Named volume: no leading /, ~, ., or Windows drive letter
      return (
        !hostPart.startsWith("/") &&
        !hostPart.startsWith("~") &&
        !hostPart.startsWith(".") &&
        !/^[A-Za-z]:[\\/]/.test(hostPart)
      );
    }).map((v) => v.split(":")[0]);

    if (namedVolumes.length === 0) return;

    const volumeArgs = namedVolumes.flatMap((vol, i) => ["-v", `${vol}:/chown_vol_${i}`]);
    const targets = namedVolumes.map((_, i) => `/chown_vol_${i}`).join(" ");
    try {
      await this.docker.runEphemeral([
        ...volumeArgs,
        "alpine",
        "sh", "-c", `chown -R 1000:1000 ${targets}`,
      ]);
    } catch (err) {
      console.warn(`[containers] Warning: failed to chown named volumes: ${err}`);
    }
  }

  private resolveKey(
    agentId: string,
    agentConfig: AgentConfig,
    scope: string
  ): string {
    if (agentConfig.container?.isolation === "session") {
      const hash = createHash("sha256")
        .update(scope)
        .digest("hex")
        .slice(0, 12);
      return `${agentId}:${hash}`;
    }
    return agentId;
  }

  private async waitForHealth(port: number): Promise<void> {
    const { interval_ms, timeout_ms } = this.config.health_check;
    const deadline = Date.now() + timeout_ms;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://localhost:${port}/health`, {
          signal: AbortSignal.timeout(interval_ms),
        });
        if (res.ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, interval_ms));
    }

    throw new Error(
      `Container health check timed out after ${timeout_ms}ms on port ${port}`
    );
  }
}
