import { describe, it, expect } from 'vitest';
import { resolveAgent, parseScope } from '@/lib/router';
import type { PlatformConfig } from '@/types';

const testConfig: PlatformConfig = {
  channels: {
    terminal: { enabled: true, agent: 'main' },
    discord: {
      enabled: true,
      token: 'test-token',
      bindings: [
        { server: '111', agent: 'general-agent', channels: '*' },
        { server: '222', agent: 'specific-agent', channels: ['chan1', 'chan2'] },
        { server: '333', agent: 'single-chan-agent', channels: 'chan3' },
      ],
    },
  },
  rbac: {
    roles: {},
    users: {},
  },
};

describe('Router', () => {
  describe('parseScope', () => {
    it('parses a discord scope', () => {
      const parsed = parseScope('discord:111:456:789');
      expect(parsed.platform).toBe('discord');
      expect(parsed.server).toBe('111');
      expect(parsed.channel).toBe('456');
      expect(parsed.user).toBe('789');
    });

    it('parses a terminal scope', () => {
      const parsed = parseScope('terminal:user123');
      expect(parsed.platform).toBe('terminal');
      expect(parsed.user).toBe('user123');
    });

    it('handles scopes with extra segments', () => {
      const parsed = parseScope('discord:a:b:c:extra');
      expect(parsed.platform).toBe('discord');
      expect(parsed.server).toBe('a');
      expect(parsed.channel).toBe('b');
      expect(parsed.user).toBe('c');
    });
  });

  describe('resolveAgent', () => {
    it('resolves terminal scope to terminal agent', () => {
      const agentId = resolveAgent('terminal:user123', testConfig);
      expect(agentId).toBe('main');
    });

    it('resolves discord scope with wildcard channel binding', () => {
      const agentId = resolveAgent('discord:111:any-channel:user1', testConfig);
      expect(agentId).toBe('general-agent');
    });

    it('resolves discord scope with specific channel match (array)', () => {
      const agentId = resolveAgent('discord:222:chan1:user1', testConfig);
      expect(agentId).toBe('specific-agent');
    });

    it('resolves discord scope with specific channel match (string)', () => {
      const agentId = resolveAgent('discord:333:chan3:user1', testConfig);
      expect(agentId).toBe('single-chan-agent');
    });

    it('throws when no binding matches the channel', () => {
      expect(() => resolveAgent('discord:222:unknown-chan:user1', testConfig)).toThrow(
        /no binding/i,
      );
    });

    it('throws when no binding matches the server', () => {
      expect(() => resolveAgent('discord:999:chan1:user1', testConfig)).toThrow(
        /no binding/i,
      );
    });

    it('throws for unknown platform', () => {
      expect(() => resolveAgent('slack:user1', testConfig)).toThrow();
    });

    it('throws when terminal is not configured', () => {
      const noTerminalConfig: PlatformConfig = {
        channels: {},
        rbac: { roles: {}, users: {} },
      };
      expect(() => resolveAgent('terminal:user1', noTerminalConfig)).toThrow();
    });
  });
});
