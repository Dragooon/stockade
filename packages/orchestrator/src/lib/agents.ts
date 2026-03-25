import type { AgentConfig, AgentHandle } from '@/types';
import Docker from 'dockerode';

/** Agent lifecycle manager — handles starting, stopping, and querying agents */
export class AgentManager {
  private agents: Map<string, AgentHandle> = new Map();
  private docker: Docker;

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
  }

  /** Start a persistent agent as a child process */
  async startPersistent(agentId: string, config: AgentConfig): Promise<AgentHandle> {
    const { execa } = await import('execa');

    const port = config.port ?? 4000;
    const url = `http://localhost:${port}`;

    const childProcess = execa('node', ['packages/agent/dist/index.js'], {
      env: {
        PORT: String(port),
        AGENT_ID: agentId,
        MODEL: config.model,
        PROVIDER: config.provider,
      },
      stdio: 'pipe',
    });

    // Attach logging handlers for stdout/stderr
    if (childProcess.stdout) {
      childProcess.stdout.on('data', (data: Buffer) => {
        console.log(`[${agentId}] ${data.toString().trim()}`);
      });
    }
    if (childProcess.stderr) {
      childProcess.stderr.on('data', (data: Buffer) => {
        console.error(`[${agentId}] ${data.toString().trim()}`);
      });
    }

    // Poll /health until ready
    await this.waitForHealth(url, 30_000);

    const handle: AgentHandle = {
      process: childProcess,
      port,
      url,
    };

    this.agents.set(agentId, handle);
    return handle;
  }

  /** Spawn an ephemeral agent for a single task, return the result text */
  async spawnEphemeral(agentId: string, config: AgentConfig, task: string): Promise<string> {
    if (config.sandbox) {
      return this.spawnEphemeralDocker(agentId, config, task);
    }
    return this.spawnEphemeralProcess(agentId, config, task);
  }

  /** Spawn an ephemeral agent via host process (execa) */
  private async spawnEphemeralProcess(agentId: string, config: AgentConfig, task: string): Promise<string> {
    const { execa } = await import('execa');

    const result = await execa('node', ['packages/agent/dist/index.js', '--ephemeral'], {
      env: {
        AGENT_ID: agentId,
        MODEL: config.model,
        PROVIDER: config.provider,
        TASK: task,
        SYSTEM_PROMPT: config.system,
      },
      stdio: 'pipe',
    });

    const output = result.stdout;
    try {
      const parsed = JSON.parse(output);
      const lastAssistant = parsed.messages?.findLast(
        (m: { role: string }) => m.role === 'assistant',
      );
      return lastAssistant?.content ?? '';
    } catch {
      return output;
    }
  }

  /** Spawn an ephemeral agent via Docker container (dockerode) */
  private async spawnEphemeralDocker(agentId: string, config: AgentConfig, task: string): Promise<string> {
    const image = config.docker?.image;
    if (!image) {
      throw new Error(`Agent "${agentId}" has sandbox: true but no docker.image configured`);
    }

    const createOptions: Docker.ContainerCreateOptions = {
      Image: image,
      Env: [
        `AGENT_ID=${agentId}`,
        `MODEL=${config.model}`,
        `PROVIDER=${config.provider}`,
        `TASK=${task}`,
        `SYSTEM_PROMPT=${config.system}`,
      ],
      HostConfig: {
        AutoRemove: false,
        NetworkMode: config.docker?.network ?? 'bridge',
      },
    };

    const container = await this.docker.createContainer(createOptions);

    try {
      await container.start();
      await container.wait();

      const logStream = await container.logs({ stdout: true, stderr: false, follow: false });
      const output = logStream.toString().trim();

      try {
        const parsed = JSON.parse(output);
        const lastAssistant = parsed.messages?.findLast(
          (m: { role: string }) => m.role === 'assistant',
        );
        return lastAssistant?.content ?? '';
      } catch {
        return output;
      }
    } finally {
      try {
        await container.remove({ force: true });
      } catch {
        // Container may already be removed; ignore
      }
    }
  }

  /** Stop a specific agent */
  async stop(agentId: string): Promise<void> {
    const handle = this.agents.get(agentId);
    if (!handle) return;

    const proc = handle.process as { kill: (signal?: string) => void };
    if (proc && typeof proc.kill === 'function') {
      proc.kill('SIGTERM');
    }

    this.agents.delete(agentId);
  }

  /** Stop all running agents */
  async stopAll(): Promise<void> {
    const agentIds = Array.from(this.agents.keys());
    for (const id of agentIds) {
      await this.stop(id);
    }
  }

  /** Get the URL for a running agent */
  getAgentUrl(agentId: string): string | undefined {
    return this.agents.get(agentId)?.url;
  }

  /** Poll an agent's /health endpoint until it responds 200 */
  private async waitForHealth(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const healthUrl = `${url}/health`;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(healthUrl);
        if (response.ok) return;
      } catch {
        // Agent not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    throw new Error(`Agent at ${url} did not become healthy within ${timeoutMs}ms`);
  }
}
