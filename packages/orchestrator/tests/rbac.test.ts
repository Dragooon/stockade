import { describe, it, expect } from 'vitest';
import { buildAbility, checkAccess, checkToolAccess, resolveUser } from '@/lib/rbac';
import type { PlatformConfig } from '@/types';

const testConfig: PlatformConfig = {
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
      owner: {
        permissions: ['agent:*', 'tool:*'],
      },
      user: {
        permissions: ['agent:main', 'tool:bash'],
      },
      limited: {
        permissions: ['agent:helper'],
      },
    },
    users: {
      alice: {
        roles: ['owner'],
        identities: { discord: '111', terminal: 'alice' },
      },
      bob: {
        roles: ['user'],
        identities: { discord: '222', terminal: 'bob' },
      },
      charlie: {
        roles: ['limited'],
        identities: { discord: '333' },
      },
    },
  },
};

describe('RBAC Engine', () => {
  describe('resolveUser', () => {
    it('resolves a discord user by platform identity', () => {
      const user = resolveUser('111', 'discord', testConfig);
      expect(user).toBe('alice');
    });

    it('resolves a terminal user by platform identity', () => {
      const user = resolveUser('bob', 'terminal', testConfig);
      expect(user).toBe('bob');
    });

    it('returns undefined for unknown user', () => {
      const user = resolveUser('999', 'discord', testConfig);
      expect(user).toBeUndefined();
    });

    it('returns undefined for unknown platform', () => {
      const user = resolveUser('111', 'slack', testConfig);
      expect(user).toBeUndefined();
    });
  });

  describe('checkAccess', () => {
    it('owner can access any agent (wildcard)', () => {
      expect(checkAccess('111', 'discord', 'main', testConfig)).toBe(true);
      expect(checkAccess('111', 'discord', 'helper', testConfig)).toBe(true);
      expect(checkAccess('111', 'discord', 'anything', testConfig)).toBe(true);
    });

    it('user can access specifically permitted agent', () => {
      expect(checkAccess('222', 'discord', 'main', testConfig)).toBe(true);
    });

    it('user cannot access non-permitted agent', () => {
      expect(checkAccess('222', 'discord', 'helper', testConfig)).toBe(false);
    });

    it('limited user can access only their agent', () => {
      expect(checkAccess('333', 'discord', 'helper', testConfig)).toBe(true);
      expect(checkAccess('333', 'discord', 'main', testConfig)).toBe(false);
    });

    it('unknown user is denied', () => {
      expect(checkAccess('999', 'discord', 'main', testConfig)).toBe(false);
    });
  });

  describe('checkToolAccess', () => {
    it('owner roles grant all tools via wildcard', () => {
      expect(checkToolAccess(['owner'], 'bash', testConfig)).toBe(true);
      expect(checkToolAccess(['owner'], 'file-read', testConfig)).toBe(true);
    });

    it('user role grants specific tool', () => {
      expect(checkToolAccess(['user'], 'bash', testConfig)).toBe(true);
    });

    it('user role denies non-granted tool', () => {
      expect(checkToolAccess(['user'], 'file-write', testConfig)).toBe(false);
    });

    it('limited role with no tool permissions denies all tools', () => {
      expect(checkToolAccess(['limited'], 'bash', testConfig)).toBe(false);
    });

    it('multiple roles combine permissions', () => {
      expect(checkToolAccess(['limited', 'user'], 'bash', testConfig)).toBe(true);
    });
  });

  describe('buildAbility', () => {
    it('returns an ability object for a known user', () => {
      const ability = buildAbility('111', 'discord', testConfig);
      expect(ability).toBeDefined();
      expect(ability.can('access', 'agent:main')).toBe(true);
    });

    it('returns a restrictive ability for unknown user', () => {
      const ability = buildAbility('999', 'discord', testConfig);
      expect(ability).toBeDefined();
      expect(ability.can('access', 'agent:main')).toBe(false);
    });
  });
});
