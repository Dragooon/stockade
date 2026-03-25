import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadAgentsConfig, loadPlatformConfig, substituteEnvVars } from '@/lib/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Config Loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('substituteEnvVars', () => {
    it('replaces ${VAR} with environment variable values', () => {
      vi.stubEnv('TEST_TOKEN', 'my-secret-token');
      const result = substituteEnvVars('token: ${TEST_TOKEN}');
      expect(result).toBe('token: my-secret-token');
    });

    it('replaces multiple env vars in one string', () => {
      vi.stubEnv('HOST', 'localhost');
      vi.stubEnv('PORT', '3000');
      const result = substituteEnvVars('${HOST}:${PORT}');
      expect(result).toBe('localhost:3000');
    });

    it('leaves string unchanged when no env vars present', () => {
      const result = substituteEnvVars('no variables here');
      expect(result).toBe('no variables here');
    });

    it('replaces missing env vars with empty string', () => {
      delete process.env.NONEXISTENT_VAR;
      const result = substituteEnvVars('value: ${NONEXISTENT_VAR}');
      expect(result).toBe('value: ');
    });
  });

  describe('loadAgentsConfig', () => {
    it('loads and validates a valid agents config', () => {
      const yaml = `
agents:
  main:
    model: "claude-sonnet-4-20250514"
    provider: "anthropic"
    system: "You are a helpful assistant."
    tools: ["bash", "file-read"]
    sandbox: false
    lifecycle: persistent
    port: 4000
`;
      const filePath = path.join(tmpDir, 'agents.yaml');
      fs.writeFileSync(filePath, yaml);

      const config = loadAgentsConfig(filePath);
      expect(config.agents.main).toBeDefined();
      expect(config.agents.main.model).toBe('claude-sonnet-4-20250514');
      expect(config.agents.main.tools).toEqual(['bash', 'file-read']);
      expect(config.agents.main.sandbox).toBe(false);
      expect(config.agents.main.lifecycle).toBe('persistent');
      expect(config.agents.main.port).toBe(4000);
    });

    it('loads config with optional fields', () => {
      const yaml = `
agents:
  sandboxed:
    model: "claude-sonnet-4-20250514"
    provider: "anthropic"
    system: "Sandboxed agent"
    tools: []
    sandbox: true
    lifecycle: ephemeral
    docker:
      image: "agent:latest"
      network: "agent-net"
    memory:
      dir: "/data/memory"
    mcp:
      - name: "test-server"
        url: "http://localhost:3001"
`;
      const filePath = path.join(tmpDir, 'agents.yaml');
      fs.writeFileSync(filePath, yaml);

      const config = loadAgentsConfig(filePath);
      expect(config.agents.sandboxed.docker?.image).toBe('agent:latest');
      expect(config.agents.sandboxed.memory?.dir).toBe('/data/memory');
      expect(config.agents.sandboxed.mcp?.[0].name).toBe('test-server');
    });

    it('throws on invalid config (missing required fields)', () => {
      const yaml = `
agents:
  bad:
    model: "claude-sonnet-4-20250514"
`;
      const filePath = path.join(tmpDir, 'agents.yaml');
      fs.writeFileSync(filePath, yaml);

      expect(() => loadAgentsConfig(filePath)).toThrow();
    });

    it('throws on invalid lifecycle value', () => {
      const yaml = `
agents:
  bad:
    model: "claude-sonnet-4-20250514"
    provider: "anthropic"
    system: "test"
    tools: []
    sandbox: false
    lifecycle: "invalid"
`;
      const filePath = path.join(tmpDir, 'agents.yaml');
      fs.writeFileSync(filePath, yaml);

      expect(() => loadAgentsConfig(filePath)).toThrow();
    });
  });

  describe('loadPlatformConfig', () => {
    it('loads and validates a valid platform config', () => {
      const yaml = `
channels:
  terminal:
    enabled: true
    agent: main
  discord:
    enabled: true
    token: "test-token"
    bindings:
      - server: "123"
        agent: main
        channels: "*"
rbac:
  roles:
    owner:
      permissions: ["agent:*", "tool:*"]
    user:
      permissions: ["agent:main"]
  users:
    alice:
      roles: ["owner"]
      identities:
        discord: "111"
        terminal: "alice"
`;
      const filePath = path.join(tmpDir, 'platform.yaml');
      fs.writeFileSync(filePath, yaml);

      const config = loadPlatformConfig(filePath);
      expect(config.channels.terminal?.enabled).toBe(true);
      expect(config.channels.discord?.bindings).toHaveLength(1);
      expect(config.rbac.roles.owner.permissions).toContain('agent:*');
      expect(config.rbac.users.alice.roles).toContain('owner');
    });

    it('performs env var substitution in values', () => {
      vi.stubEnv('DISCORD_TOKEN', 'real-discord-token');
      const yaml = `
channels:
  discord:
    enabled: true
    token: "\${DISCORD_TOKEN}"
    bindings: []
rbac:
  roles: {}
  users: {}
`;
      const filePath = path.join(tmpDir, 'platform.yaml');
      fs.writeFileSync(filePath, yaml);

      const config = loadPlatformConfig(filePath);
      expect(config.channels.discord?.token).toBe('real-discord-token');
    });

    it('throws on invalid platform config', () => {
      const yaml = `
channels: "not-an-object"
`;
      const filePath = path.join(tmpDir, 'platform.yaml');
      fs.writeFileSync(filePath, yaml);

      expect(() => loadPlatformConfig(filePath)).toThrow();
    });

    it('supports channels as array of strings', () => {
      const yaml = `
channels:
  discord:
    enabled: true
    token: "test"
    bindings:
      - server: "123"
        agent: main
        channels:
          - "chan1"
          - "chan2"
rbac:
  roles: {}
  users: {}
`;
      const filePath = path.join(tmpDir, 'platform.yaml');
      fs.writeFileSync(filePath, yaml);

      const config = loadPlatformConfig(filePath);
      expect(config.channels.discord?.bindings[0].channels).toEqual(['chan1', 'chan2']);
    });
  });
});
