import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentManager } from '@/lib/agents';
import type { AgentConfig } from '@/types';
import { createServer, Server } from 'http';

// Mock execa
vi.mock('execa', () => {
  return {
    execa: vi.fn(),
  };
});

describe('Agent Manager', () => {
  let manager: AgentManager;
  let mockServer: Server | null = null;

  beforeEach(() => {
    manager = new AgentManager();
  });

  afterEach(async () => {
    await manager.stopAll();
    if (mockServer) {
      mockServer.close();
      mockServer = null;
    }
    vi.restoreAllMocks();
  });

  const persistentConfig: AgentConfig = {
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    system: 'You are helpful.',
    tools: ['bash'],
    sandbox: false,
    lifecycle: 'persistent',
    port: 0, // will be overridden
  };

  const ephemeralConfig: AgentConfig = {
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    system: 'You are helpful.',
    tools: [],
    sandbox: false,
    lifecycle: 'ephemeral',
  };

  describe('startPersistent', () => {
    it('starts a persistent agent and returns a handle', async () => {
      // Create a mock health server
      const port = await new Promise<number>((resolve) => {
        mockServer = createServer((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, agentId: 'test-agent' }));
        });
        mockServer.listen(0, () => {
          const addr = mockServer!.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });

      // Mock execa to return a fake child process
      const { execa } = await import('execa');
      const mockedExeca = vi.mocked(execa);
      const fakeProcess = {
        pid: 12345,
        kill: vi.fn(),
        on: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      };
      mockedExeca.mockReturnValue(fakeProcess as any);

      const config = { ...persistentConfig, port };
      const handle = await manager.startPersistent('test-agent', config);

      expect(handle.port).toBe(port);
      expect(handle.url).toBe(`http://localhost:${port}`);
    });

    it('getAgentUrl returns URL for running agent', async () => {
      const port = await new Promise<number>((resolve) => {
        mockServer = createServer((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        mockServer.listen(0, () => {
          const addr = mockServer!.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });

      const { execa } = await import('execa');
      const mockedExeca = vi.mocked(execa);
      mockedExeca.mockReturnValue({
        pid: 12345,
        kill: vi.fn(),
        on: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      } as any);

      await manager.startPersistent('test-agent', { ...persistentConfig, port });
      expect(manager.getAgentUrl('test-agent')).toBe(`http://localhost:${port}`);
    });

    it('getAgentUrl returns undefined for unknown agent', () => {
      expect(manager.getAgentUrl('nonexistent')).toBeUndefined();
    });
  });

  describe('stop', () => {
    it('stops a running agent', async () => {
      const port = await new Promise<number>((resolve) => {
        mockServer = createServer((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        mockServer.listen(0, () => {
          const addr = mockServer!.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });

      const { execa } = await import('execa');
      const mockedExeca = vi.mocked(execa);
      const killFn = vi.fn();
      mockedExeca.mockReturnValue({
        pid: 12345,
        kill: killFn,
        on: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      } as any);

      await manager.startPersistent('test-agent', { ...persistentConfig, port });
      await manager.stop('test-agent');

      expect(killFn).toHaveBeenCalled();
      expect(manager.getAgentUrl('test-agent')).toBeUndefined();
    });

    it('does nothing for unknown agent', async () => {
      await expect(manager.stop('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('stopAll', () => {
    it('stops all running agents', async () => {
      const port1 = await new Promise<number>((resolve) => {
        const s = createServer((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        s.listen(0, () => {
          const addr = s.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
        // Store for cleanup
        if (!mockServer) mockServer = s;
      });

      const { execa } = await import('execa');
      const mockedExeca = vi.mocked(execa);
      const killFn = vi.fn();
      mockedExeca.mockReturnValue({
        pid: 12345,
        kill: killFn,
        on: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      } as any);

      await manager.startPersistent('agent1', { ...persistentConfig, port: port1 });
      await manager.stopAll();

      expect(killFn).toHaveBeenCalled();
      expect(manager.getAgentUrl('agent1')).toBeUndefined();
    });
  });

  describe('spawnEphemeral', () => {
    it('spawns an ephemeral agent for a task', async () => {
      const { execa } = await import('execa');
      const mockedExeca = vi.mocked(execa);
      mockedExeca.mockResolvedValue({
        stdout: JSON.stringify({
          messages: [{ role: 'assistant', content: 'Task result' }],
          usage: {},
          finishReason: 'stop',
        }),
        exitCode: 0,
      } as any);

      const result = await manager.spawnEphemeral('helper', ephemeralConfig, 'Do something');
      expect(result).toBe('Task result');
    });

    it('throws when ephemeral agent fails', async () => {
      const { execa } = await import('execa');
      const mockedExeca = vi.mocked(execa);
      mockedExeca.mockRejectedValue(new Error('Process exited with code 1'));

      await expect(
        manager.spawnEphemeral('helper', ephemeralConfig, 'Do something'),
      ).rejects.toThrow();
    });
  });

  describe('spawnEphemeral (Docker sandbox)', () => {
    const sandboxedConfig: AgentConfig = {
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      system: 'You are helpful.',
      tools: [],
      sandbox: true,
      lifecycle: 'ephemeral',
      docker: {
        image: 'agent-sandbox:latest',
        network: 'agent-net',
      },
    };

    function createMockDocker() {
      const mockContainer = {
        start: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
        logs: vi.fn().mockResolvedValue(Buffer.from('')),
        remove: vi.fn().mockResolvedValue(undefined),
      };

      const mockDocker = {
        createContainer: vi.fn().mockResolvedValue(mockContainer),
      };

      return { mockDocker, mockContainer };
    }

    it('uses Docker when sandbox is true', async () => {
      const { mockDocker, mockContainer } = createMockDocker();
      mockContainer.logs.mockResolvedValue(
        Buffer.from(JSON.stringify({
          messages: [{ role: 'assistant', content: 'Docker result' }],
          usage: {},
          finishReason: 'stop',
        })),
      );

      const dockerManager = new AgentManager(mockDocker as any);
      const result = await dockerManager.spawnEphemeral('sandbox-agent', sandboxedConfig, 'Run in Docker');

      expect(result).toBe('Docker result');
      expect(mockDocker.createContainer).toHaveBeenCalledOnce();
      expect(mockContainer.start).toHaveBeenCalledOnce();
      expect(mockContainer.wait).toHaveBeenCalledOnce();
      expect(mockContainer.logs).toHaveBeenCalledWith({ stdout: true, stderr: false, follow: false });
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it('passes correct container options including image and network', async () => {
      const { mockDocker, mockContainer } = createMockDocker();
      mockContainer.logs.mockResolvedValue(Buffer.from('plain output'));

      const dockerManager = new AgentManager(mockDocker as any);
      await dockerManager.spawnEphemeral('sandbox-agent', sandboxedConfig, 'My task');

      const createCall = mockDocker.createContainer.mock.calls[0][0];
      expect(createCall.Image).toBe('agent-sandbox:latest');
      expect(createCall.Env).toContain('AGENT_ID=sandbox-agent');
      expect(createCall.Env).toContain('MODEL=claude-sonnet-4-20250514');
      expect(createCall.Env).toContain('PROVIDER=anthropic');
      expect(createCall.Env).toContain('TASK=My task');
      expect(createCall.Env).toContain('SYSTEM_PROMPT=You are helpful.');
      expect(createCall.HostConfig.NetworkMode).toBe('agent-net');
    });

    it('uses bridge network by default when docker.network is not set', async () => {
      const configNoNetwork: AgentConfig = {
        ...sandboxedConfig,
        docker: { image: 'agent-sandbox:latest' },
      };

      const { mockDocker, mockContainer } = createMockDocker();
      mockContainer.logs.mockResolvedValue(Buffer.from('output'));

      const dockerManager = new AgentManager(mockDocker as any);
      await dockerManager.spawnEphemeral('sandbox-agent', configNoNetwork, 'Task');

      const createCall = mockDocker.createContainer.mock.calls[0][0];
      expect(createCall.HostConfig.NetworkMode).toBe('bridge');
    });

    it('returns raw output when container output is not valid JSON', async () => {
      const { mockDocker, mockContainer } = createMockDocker();
      mockContainer.logs.mockResolvedValue(Buffer.from('plain text output'));

      const dockerManager = new AgentManager(mockDocker as any);
      const result = await dockerManager.spawnEphemeral('sandbox-agent', sandboxedConfig, 'Task');

      expect(result).toBe('plain text output');
    });

    it('removes container even when execution fails', async () => {
      const { mockDocker, mockContainer } = createMockDocker();
      mockContainer.start.mockRejectedValue(new Error('Container start failed'));

      const dockerManager = new AgentManager(mockDocker as any);

      await expect(
        dockerManager.spawnEphemeral('sandbox-agent', sandboxedConfig, 'Task'),
      ).rejects.toThrow('Container start failed');

      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it('throws when sandbox is true but docker.image is missing', async () => {
      const configNoDocker: AgentConfig = {
        ...sandboxedConfig,
        docker: undefined,
      };

      const { mockDocker } = createMockDocker();
      const dockerManager = new AgentManager(mockDocker as any);

      await expect(
        dockerManager.spawnEphemeral('sandbox-agent', configNoDocker, 'Task'),
      ).rejects.toThrow('sandbox: true but no docker.image configured');
    });

    it('does NOT use Docker when sandbox is false', async () => {
      const { execa } = await import('execa');
      const mockedExeca = vi.mocked(execa);
      mockedExeca.mockResolvedValue({
        stdout: JSON.stringify({
          messages: [{ role: 'assistant', content: 'Process result' }],
        }),
        exitCode: 0,
      } as any);

      const { mockDocker } = createMockDocker();
      const dockerManager = new AgentManager(mockDocker as any);
      const result = await dockerManager.spawnEphemeral('helper', ephemeralConfig, 'Do something');

      expect(result).toBe('Process result');
      expect(mockDocker.createContainer).not.toHaveBeenCalled();
      expect(mockedExeca).toHaveBeenCalled();
    });
  });
});
