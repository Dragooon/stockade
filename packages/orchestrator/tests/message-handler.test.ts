import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock modules before importing the handler
vi.mock('@/lib/config', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('@/lib/agent-client', () => ({
  sendToAgent: vi.fn(),
}));

vi.mock('@/lib/agents', () => {
  const AgentManager = vi.fn();
  AgentManager.prototype.getAgentUrl = vi.fn();
  AgentManager.prototype.startPersistent = vi.fn();
  AgentManager.prototype.spawnEphemeral = vi.fn();
  AgentManager.prototype.stop = vi.fn();
  AgentManager.prototype.stopAll = vi.fn();
  return { AgentManager };
});

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
  createDb: vi.fn(),
}));

import { handleMessage } from '@/lib/message-handler';
import { loadConfig } from '@/lib/config';
import { sendToAgent } from '@/lib/agent-client';
import { createDb } from '@/lib/db';
import type { PlatformConfig, AgentsConfig, RunResponse } from '@/types';

describe('Message Handler', () => {
  let tmpDir: string;
  let dbPath: string;
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
    },
  };

  const platformConfig: PlatformConfig = {
    channels: {
      terminal: { enabled: true, agent: 'main' },
      discord: {
        enabled: true,
        token: 'test-token',
        bindings: [
          { server: '123', agent: 'main', channels: '*' },
        ],
      },
    },
    rbac: {
      roles: {
        owner: { permissions: ['agent:*', 'tool:*'] },
      },
      users: {
        alice: {
          roles: ['owner'],
          identities: { discord: '111', terminal: 'alice' },
        },
      },
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-handler-test-'));
    dbPath = path.join(tmpDir, 'test.db');

    // Unmock db for real database usage
    vi.unmock('@/lib/db');
    const dbModule = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    const testDb = dbModule.createDb(dbPath);
    closeDb = testDb.close;

    vi.mocked(loadConfig).mockReturnValue({
      agents: agentsConfig,
      platform: platformConfig,
    });
  });

  afterEach(() => {
    if (closeDb) closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('processes a valid message and returns a response', async () => {
    const mockResponse: RunResponse = {
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
      usage: { totalTokens: 100 },
      finishReason: 'stop',
    };
    vi.mocked(sendToAgent).mockResolvedValue(mockResponse);

    const dbModule = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    const testDb = dbModule.createDb(dbPath);

    const result = await handleMessage(
      {
        scope: 'discord:123:456:111',
        content: 'Hello',
        userId: '111',
        platform: 'discord',
      },
      {
        agentsConfig,
        platformConfig,
        db: testDb.db,
        getAgentUrl: () => 'http://localhost:4000',
      },
    );

    expect(result.response).toBe('Hi there!');
    expect(result.sessionId).toBeDefined();
    expect(sendToAgent).toHaveBeenCalledOnce();
    testDb.close();
  });

  it('returns 403 for unauthorized user', async () => {
    const dbModule = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    const testDb = dbModule.createDb(dbPath);

    await expect(
      handleMessage(
        {
          scope: 'discord:123:456:999',
          content: 'Hello',
          userId: '999',
          platform: 'discord',
        },
        {
          agentsConfig,
          platformConfig,
          db: testDb.db,
          getAgentUrl: () => 'http://localhost:4000',
        },
      ),
    ).rejects.toThrow(/unauthorized/i);
    testDb.close();
  });

  it('returns error when no agent binding matches', async () => {
    const dbModule = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    const testDb = dbModule.createDb(dbPath);

    await expect(
      handleMessage(
        {
          scope: 'discord:999:456:111',
          content: 'Hello',
          userId: '111',
          platform: 'discord',
        },
        {
          agentsConfig,
          platformConfig,
          db: testDb.db,
          getAgentUrl: () => 'http://localhost:4000',
        },
      ),
    ).rejects.toThrow(/no binding/i);
    testDb.close();
  });

  it('returns error when agent URL is not available', async () => {
    const dbModule = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    const testDb = dbModule.createDb(dbPath);

    await expect(
      handleMessage(
        {
          scope: 'discord:123:456:111',
          content: 'Hello',
          userId: '111',
          platform: 'discord',
        },
        {
          agentsConfig,
          platformConfig,
          db: testDb.db,
          getAgentUrl: () => undefined,
        },
      ),
    ).rejects.toThrow(/not running|not available/i);
    testDb.close();
  });

  it('persists messages across calls for same scope', async () => {
    const dbModule = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    const testDb = dbModule.createDb(dbPath);

    vi.mocked(sendToAgent)
      .mockResolvedValueOnce({
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Response 1' },
        ],
        usage: {},
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        messages: [
          { role: 'user', content: 'Second' },
          { role: 'assistant', content: 'Response 2' },
        ],
        usage: {},
        finishReason: 'stop',
      });

    const deps = {
      agentsConfig,
      platformConfig,
      db: testDb.db,
      getAgentUrl: () => 'http://localhost:4000',
    };

    const result1 = await handleMessage(
      { scope: 'discord:123:456:111', content: 'First', userId: '111', platform: 'discord' },
      deps,
    );

    const result2 = await handleMessage(
      { scope: 'discord:123:456:111', content: 'Second', userId: '111', platform: 'discord' },
      deps,
    );

    // Both should use the same session
    expect(result1.sessionId).toBe(result2.sessionId);

    // Second call should have received previous messages in the request
    const secondCall = vi.mocked(sendToAgent).mock.calls[1];
    const messagesArg = secondCall[1].messages;
    // Should include persisted messages from first call plus new message
    expect(messagesArg.length).toBeGreaterThan(1);

    testDb.close();
  });
});
