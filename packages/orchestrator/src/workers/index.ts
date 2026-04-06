import type { AgentConfig } from "../types.js";

/**
 * Unified interface for managing agent worker processes.
 *
 * Implemented by HostWorkerManager (child processes) and ContainerManager (Docker).
 * The orchestrator is blind to the deployment type — it only uses this interface.
 */
export interface WorkerManager {
  /**
   * Ensure a worker is running for the given agent and scope.
   * Returns the worker's base URL (e.g., "http://localhost:4001").
   * Idempotent — safe to call if the worker is already running.
   */
  ensure(agentId: string, agentConfig: AgentConfig, scope: string): Promise<string>;

  /**
   * Restart the worker for a given agent (tear down and re-provision on next request).
   */
  restart(agentId: string, agentConfig: AgentConfig): Promise<void>;

  /**
   * Gracefully shut down all managed workers.
   */
  shutdownAll(): Promise<void>;

  /**
   * Remove orphaned workers from a previous process run.
   */
  cleanupOrphans(): Promise<void>;

  /**
   * Resolve the memory directory path as seen by the agent inside the worker.
   * - Host workers: absolute host path (<agentsDir>/<agentId>/memory)
   * - Docker workers: container path (/workspace/memory)
   */
  resolveMemoryPath(agentId: string, agentConfig: AgentConfig): string;
}
