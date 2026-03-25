import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('@/lib/agents', () => {
  const AgentManager = vi.fn();
  AgentManager.prototype.spawnEphemeral = vi.fn();
  AgentManager.prototype.getAgentUrl = vi.fn();
  AgentManager.prototype.startPersistent = vi.fn();
  AgentManager.prototype.stop = vi.fn();
  AgentManager.prototype.stopAll = vi.fn();
  return { AgentManager };
});

import { handleSubAgent } from '@/lib/subagent-handler';
import type { PlatformConfig, AgentsConfig } from '@/types';

describe('Sub-agent Handler', () => {
  let tmpDir: string;
  let closeDb: () => void;

  const agentsConfig: AgentsConfig = {
    agents: {
      main: {
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        system: 'You are helpful.',
        tools: ['bash'],
        sandbox: false,
        lifecycle: 'persistent',
        port: 4000,
      },
      helper: {
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        system: 'You are a helper agent.',
        tools: [],
        sandbox: false,
        lifecycle: 'ephemeral',
      },
    },
  };

  const platformConfig: PlatformConfig = {
    channels: {
      terminal: { enabled: true, agent: 'main' },
    },
    rbac: {
      roles: {
        owner: { permissions: ['agent:*', 'tool:*'] },
      },
      users: {
        alice: {
          roles: ['owner'],
          identities: { terminal: 'alice' },
        },
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-test-'));
  });

  afterEach(() => {
    if (closeDb) closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('spawns an ephemeral agent and returns the result', async () => {
    const dbPath = path.join(tmpDir, 'test.db');
    const dbModule = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    const testDb = dbModule.createDb(dbPath);
    closeDb = testDb.close;

    // Create a parent session first
    const sessionsModule = await vi.importActual<typeof import('@/lib/sessions')>('@/lib/sessions');
    const parentSession = sessionsModule.getOrCreateSession(testDb.db, 'terminal:alice', 'main');

    const { AgentManager } = await import('@/lib/agents');
    const mockSpawnEphemeral = vi.fn().mockResolvedValue('Task completed successfully');

    const result = await handleSubAgent(
      {
        parentSessionId: parentSession.id,
        agentId: 'helper',
        task: 'Do something useful',
        context: 'Some context',
      },
      {
        agentsConfig,
        platformConfig,
        db: testDb.db,
        spawnEphemeral: mockSpawnEphemeral,
      },
    );

    expect(result.result).toBe('Task completed successfully');
    expect(mockSpawnEphemeral).toHaveBeenCalledWith(
      'helper',
      agentsConfig.agents.helper,
      'Context: Some context\n\nTask: Do something useful',
    );
  });

  it('throws when parent session does not exist', async () => {
    const dbPath = path.join(tmpDir, 'test.db');
    const dbModule = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    const testDb = dbModule.createDb(dbPath);
    closeDb = testDb.close;

    await expect(
      handleSubAgent(
        {
          parentSessionId: 'nonexistent-session-id',
          agentId: 'helper',
          task: 'Do something',
        },
        {
          agentsConfig,
          platformConfig,
          db: testDb.db,
          spawnEphemeral: vi.fn(),
        },
      ),
    ).rejects.toThrow(/parent session/i);
  });

  it('throws when agent is not found in config', async () => {
    const dbPath = path.join(tmpDir, 'test.db');
    const dbModule = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    const testDb = dbModule.createDb(dbPath);
    closeDb = testDb.close;

    const sessionsModule = await vi.importActual<typeof import('@/lib/sessions')>('@/lib/sessions');
    const parentSession = sessionsModule.getOrCreateSession(testDb.db, 'terminal:alice', 'main');

    await expect(
      handleSubAgent(
        {
          parentSessionId: parentSession.id,
          agentId: 'nonexistent-agent',
          task: 'Do something',
        },
        {
          agentsConfig,
          platformConfig,
          db: testDb.db,
          spawnEphemeral: vi.fn(),
        },
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('throws when user lacks access to sub-agent', async () => {
    const dbPath = path.join(tmpDir, 'test.db');
    const dbModule = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    const testDb = dbModule.createDb(dbPath);
    closeDb = testDb.close;

    const sessionsModule = await vi.importActual<typeof import('@/lib/sessions')>('@/lib/sessions');
    const parentSession = sessionsModule.getOrCreateSession(testDb.db, 'terminal:alice', 'main');

    // Config where alice doesn't have access to helper
    const restrictedConfig: PlatformConfig = {
      channels: { terminal: { enabled: true, agent: 'main' } },
      rbac: {
        roles: {
          limited: { permissions: ['agent:main'] },
        },
        users: {
          alice: {
            roles: ['limited'],
            identities: { terminal: 'alice' },
          },
        },
      },
    };

    await expect(
      handleSubAgent(
        {
          parentSessionId: parentSession.id,
          agentId: 'helper',
          task: 'Do something',
        },
        {
          agentsConfig,
          platformConfig: restrictedConfig,
          db: testDb.db,
          spawnEphemeral: vi.fn(),
        },
      ),
    ).rejects.toThrow(/unauthorized/i);
  });
});
