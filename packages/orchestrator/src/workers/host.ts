/**
 * HostWorkerManager — manages worker child processes running on the host.
 *
 * One persistent worker process per agentId, each on its own port (4001-4099).
 * Workers are spawned on demand and kept alive across dispatches.
 * A health monitor polls each worker every 30s and restarts it if it goes down.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { AgentConfig } from "../types.js";
import type { WorkerManager } from "./index.js";
import { PortAllocator } from "../containers/ports.js";
import { createWorkerLogger } from "../log.js";
import { WORKER_AUTH_TOKEN } from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Workspace root: packages/orchestrator/{src,dist}/workers/ → 4 levels up
const WORKSPACE_ROOT = resolve(__dirname, "../../../..");
// Host workers run TypeScript source via tsx to avoid pnpm symlink issues on Windows.
// Docker containers use the compiled dist; host processes use tsx directly.
const HOST_WORKER_SCRIPT = resolve(WORKSPACE_ROOT, "packages/worker/src/index.ts");
const HOST_PORT_RANGE: [number, number] = [4001, 4099];

/** Environment a host_user agent's worker inherits from the orchestrator. */
const ISOLATED_WORKER_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR", "NODE_ENV", "CLAUDE_CODE_EXECUTABLE"];

function pickEnv(env: NodeJS.ProcessEnv, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
}

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

  lookupExisting(agentId: string): string | undefined {
    const existing = this.workers.get(agentId);
    return existing?.alive ? existing.url : undefined;
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

  resolveMemoryPath(agentId: string, agentConfig: AgentConfig): string {
    return join(agentConfig.host_user?.workspace ?? join(this.agentsDir, agentId), "memory");
  }

  // ── Private ──

  private async startWorker(agentId: string, agentConfig: AgentConfig): Promise<string> {
    const port = this.portAllocator.allocate();

    // Agents with a host_user only start Claude as that user (sudo -u), so the
    // worker gets a minimal environment: none of the orchestrator's secrets
    // (Discord token, API token, …) reach it, and it listens on loopback only.
    const isolated = !!agentConfig.host_user;
    const inherited = isolated ? pickEnv(process.env, ISOLATED_WORKER_ENV) : process.env;
    const env = {
      ...inherited,
      ...this.extraEnv,
      ...(agentConfig.host?.env ?? {}),
      PORT: String(port),
      WORKER_ID: `host-${agentId}`,
      AGENT_ID: agentId,
      AGENT_WORKSPACE: agentConfig.host_user?.workspace ?? join(this.agentsDir, agentId),
      WORKER_HOST: "127.0.0.1",
      WORKER_AUTH_TOKEN,
    };

    // The orchestrator may hold CAP_DAC_READ_SEARCH (to index agents' private
    // transcripts); an isolated worker doesn't need it, so it's dropped here.
    const [cmd, args] = isolated && existsSync("/usr/bin/setpriv")
      ? ["/usr/bin/setpriv", ["--inh-caps=-all", "--ambient-caps=-all", "--", "node", "--import", "tsx", HOST_WORKER_SCRIPT]]
      : ["node", ["--import", "tsx", HOST_WORKER_SCRIPT]];
    const child = spawn(cmd, args, {
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
