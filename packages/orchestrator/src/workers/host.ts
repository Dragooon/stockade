/**
 * HostWorkerManager — manages worker child processes running on the host.
 *
 * One persistent worker process per agentId, each on its own port (4001-4099).
 * Workers are spawned on demand and kept alive across dispatches.
 * A health monitor polls each worker every 30s and restarts it if it goes down.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { AgentConfig } from "../types.js";
import type { WorkerManager } from "./index.js";
import { PortAllocator } from "../containers/ports.js";
import { createWorkerLogger } from "../log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Workspace root: packages/orchestrator/{src,dist}/workers/ → 4 levels up
const WORKSPACE_ROOT = resolve(__dirname, "../../../..");
// Host workers run TypeScript source via tsx to avoid pnpm symlink issues on Windows.
// Docker containers use the compiled dist; host processes use tsx directly.
const HOST_WORKER_SCRIPT = resolve(WORKSPACE_ROOT, "packages/worker/src/index.ts");
const HOST_PORT_RANGE: [number, number] = [4001, 4099];

interface WorkerProcess {
  child: ChildProcess;
  port: number;
  url: string;
  agentId: string;
  alive: boolean;
}

export class HostWorkerManager implements WorkerManager {
  private readonly workers = new Map<string, WorkerProcess>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly portAllocator = new PortAllocator(HOST_PORT_RANGE);
  private healthTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly agentsDir: string,
    private readonly logsDir: string,
    /** Extra environment variables injected into every spawned worker process. */
    private readonly extraEnv: Record<string, string> = {},
  ) {
    // Health monitor: restart dead workers every 30s
    this.healthTimer = setInterval(() => {
      this.checkHealth().catch(() => {});
    }, 30_000);
  }

  async ensure(agentId: string, agentConfig: AgentConfig, _scope: string): Promise<string> {
    const existing = this.workers.get(agentId);
    if (existing?.alive) return existing.url;

    // Deduplicate concurrent starts for the same agent
    const inflight = this.inflight.get(agentId);
    if (inflight) return inflight;

    const promise = this.startWorker(agentId, agentConfig);
    this.inflight.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(agentId);
    }
  }

  async restart(agentId: string, _agentConfig: AgentConfig): Promise<void> {
    await this.stopWorker(agentId);
    console.log(`[host-workers] ${agentId} stopped — will re-start on next request`);
  }

  /**
   * Dispatch-boundary cleanup for the Madge Chrome profile. Defense-in-depth
   * companion to the worker-side cleanup in `packages/worker/src/browse-cleanup.ts`
   * — runs at browse-worker spawn/stop (rare) to catch crash-recovery cases the
   * worker couldn't clean itself. Keep this in sync with the worker version.
   */
  private cleanupBrowseChrome(): void {
    try {
      if (process.platform === "win32") {
        const ps =
          "Get-WmiObject Win32_Process -Filter \"Name='chrome.exe'\" | " +
          "Where-Object {$_.CommandLine -like '*--user-data-dir=*madge*'} | " +
          "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; " +
          "Get-WmiObject Win32_Process -Filter \"Name='node.exe'\" | " +
          "Where-Object {$_.CommandLine -like '*chrome-devtools-mcp*'} | " +
          "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
        spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
          stdio: "ignore",
          timeout: 8_000,
        });
      } else {
        spawnSync("pkill", ["-f", "--user-data-dir=.*madge"], { stdio: "ignore", timeout: 5_000 });
        spawnSync("pkill", ["-f", "chrome-devtools-mcp"], { stdio: "ignore", timeout: 5_000 });
      }
      rmSync(join(homedir(), ".agent-browser", "profiles", "madge", "lockfile"), { force: true });
    } catch {
      // best-effort
    }
  }

  async shutdownAll(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    const ids = [...this.workers.keys()];
    await Promise.all(ids.map((id) => this.stopWorker(id)));
  }

  async cleanupOrphans(): Promise<void> {
    // Host workers don't persist across process restarts — nothing to clean up
  }

  resolveMemoryPath(agentId: string, _agentConfig: AgentConfig): string {
    return join(this.agentsDir, agentId, "memory");
  }

  // ── Private ──

  private async startWorker(agentId: string, agentConfig: AgentConfig): Promise<string> {
    const port = this.portAllocator.allocate();

    // browse parents an agent-browser daemon + Chrome. If a previous worker died
    // without taking them down, the old Chrome holds the profile lock and the new
    // session ends up in a stale or duplicate window. Sweep before spawning.
    if (agentId === "browse") {
      this.cleanupBrowseChrome();
    }

    const env = {
      ...process.env,
      ...this.extraEnv,
      ...(agentConfig.host?.env ?? {}),
      PORT: String(port),
      WORKER_ID: `host-${agentId}`,
      AGENT_ID: agentId,
      AGENT_WORKSPACE: join(this.agentsDir, agentId),
    };

    const child = spawn("node", ["--import", "tsx", HOST_WORKER_SCRIPT], {
      env,
      cwd: WORKSPACE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    const log = createWorkerLogger(this.logsDir, agentId);
    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString().trimEnd();
      log(text);
      process.stdout.write(`[worker:${agentId}] ${d}`);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString().trimEnd();
      log(`[stderr] ${text}`);
      process.stderr.write(`[worker:${agentId}] ${d}`);
    });

    const wp: WorkerProcess = {
      child,
      port,
      url: `http://localhost:${port}`,
      agentId,
      alive: false,
    };

    child.on("exit", (code) => {
      console.log(`[host-workers] ${agentId} exited (code ${code})`);
      const current = this.workers.get(agentId);
      if (current?.child === child) {
        current.alive = false;
        this.portAllocator.release(port);
      }
    });

    this.workers.set(agentId, wp);

    // Wait for health check
    await this.waitForHealth(port, 15_000);
    wp.alive = true;

    console.log(`[host-workers] ${agentId} started on port ${port}`);
    return wp.url;
  }

  private async stopWorker(agentId: string): Promise<void> {
    const wp = this.workers.get(agentId);
    if (!wp) return;

    this.workers.delete(agentId);
    this.portAllocator.release(wp.port);
    wp.alive = false;

    try {
      wp.child.kill("SIGTERM");
      // Give it 5s to exit gracefully
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          wp.child.kill("SIGKILL");
          resolve();
        }, 5_000);
        wp.child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    } catch {
      // Best-effort
    }

    if (agentId === "browse") {
      this.cleanupBrowseChrome();
    }
  }

  private async waitForHealth(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://localhost:${port}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Host worker on port ${port} did not become healthy within ${timeoutMs}ms`);
  }

  private async checkHealth(): Promise<void> {
    for (const [agentId, wp] of this.workers) {
      if (!wp.alive) continue;
      try {
        const res = await fetch(`${wp.url}/health`, { signal: AbortSignal.timeout(3_000) });
        if (!res.ok) {
          console.log(`[host-workers] ${agentId} unhealthy — marking dead`);
          wp.alive = false;
          this.portAllocator.release(wp.port);
        }
      } catch {
        console.log(`[host-workers] ${agentId} unreachable — marking dead`);
        wp.alive = false;
        this.portAllocator.release(wp.port);
      }
    }
  }
}
