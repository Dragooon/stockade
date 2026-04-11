/**
 * HostWorkerManager — manages worker child processes running on the host.
 *
 * One persistent worker process per agentId, each on its own port (4001-4099).
 * Workers are spawned on demand and kept alive across dispatches.
 * A health monitor polls each worker every 30s and restarts it if it goes down.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { AgentConfig } from "../types.js";
import type { WorkerManager } from "./index.js";
import { PortAllocator } from "../containers/ports.js";
import { createWorkerLogger } from "../log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Worker script: src/workers/ → ../../../ → packages/ → worker/dist/index.js
const WORKER_SCRIPT = resolve(__dirname, "../../../worker/dist/index.js");
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

  private async startWorker(agentId: string, _agentConfig: AgentConfig): Promise<string> {
    const port = this.portAllocator.allocate();

    const env = {
      ...process.env,
      ...this.extraEnv,
      PORT: String(port),
      WORKER_ID: `host-${agentId}`,
      AGENT_ID: agentId,
      AGENT_WORKSPACE: join(this.agentsDir, agentId),
    };

    const child = spawn("node", [WORKER_SCRIPT], {
      env,
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
