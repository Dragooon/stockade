import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import type { AgentsConfig, PlatformConfig } from '@/types';

/** Replace ${VAR_NAME} placeholders with process.env values */
export function substituteEnvVars(text: string): string {
  return text.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
    return process.env[varName] ?? '';
  });
}

const mcpServerSchema = z.object({
  name: z.string(),
  url: z.string(),
});

const agentConfigSchema = z.object({
  model: z.string(),
  provider: z.string(),
  system: z.string(),
  tools: z.array(z.string()),
  mcp: z.array(mcpServerSchema).optional(),
  sandbox: z.boolean(),
  lifecycle: z.enum(['persistent', 'ephemeral']),
  port: z.number().optional(),
  memory: z.object({ dir: z.string() }).optional(),
  docker: z.object({
    image: z.string(),
    network: z.string().optional(),
  }).optional(),
});

const agentsConfigSchema = z.object({
  agents: z.record(z.string(), agentConfigSchema),
});

const channelBindingSchema = z.object({
  server: z.string(),
  agent: z.string(),
  channels: z.union([z.string(), z.array(z.string())]),
});

const platformConfigSchema = z.object({
  channels: z.object({
    terminal: z.object({
      enabled: z.boolean(),
      agent: z.string(),
    }).optional(),
    discord: z.object({
      enabled: z.boolean(),
      token: z.string(),
      bindings: z.array(channelBindingSchema),
    }).optional(),
  }),
  rbac: z.object({
    roles: z.record(z.string(), z.object({
      permissions: z.array(z.string()),
    })),
    users: z.record(z.string(), z.object({
      roles: z.array(z.string()),
      identities: z.record(z.string(), z.string()),
    })),
  }),
});

function readYamlFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const substituted = substituteEnvVars(raw);
  return yaml.load(substituted);
}

export function loadAgentsConfig(filePath: string): AgentsConfig {
  const data = readYamlFile(filePath);
  return agentsConfigSchema.parse(data);
}

export function loadPlatformConfig(filePath: string): PlatformConfig {
  const data = readYamlFile(filePath);
  return platformConfigSchema.parse(data);
}

/** Load both config files from the given config directory */
export function loadConfig(configDir: string): { agents: AgentsConfig; platform: PlatformConfig } {
  const agents = loadAgentsConfig(`${configDir}/agents.yaml`);
  const platform = loadPlatformConfig(`${configDir}/platform.yaml`);
  return { agents, platform };
}
