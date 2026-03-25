import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { AgentsConfig, PlatformConfig } from "./types.js";

// --- Zod schemas ---

const agentConfigSchema = z.object({
  model: z.string(),
  system: z.string(),
  tools: z.array(z.string()),
  lifecycle: z.enum(["persistent", "ephemeral"]),
  remote: z.boolean().default(false),
  port: z.number().optional(),
  url: z.string().optional(),
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
    terminal: z
      .object({
        enabled: z.boolean(),
        agent: z.string(),
      })
      .optional(),
    discord: z
      .object({
        enabled: z.boolean(),
        token: z.string(),
        bindings: z.array(channelBindingSchema),
      })
      .optional(),
  }),
  rbac: z.object({
    roles: z.record(z.string(), z.object({ permissions: z.array(z.string()) })),
    users: z.record(
      z.string(),
      z.object({
        roles: z.array(z.string()),
        identities: z.record(z.string(), z.string()),
      })
    ),
  }),
});

// --- Environment variable substitution ---

/**
 * Recursively substitute `${ENV_VAR}` patterns in strings within a value.
 * Throws if a referenced env var is not set.
 */
export function substituteEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
      return process.env[varName] ?? "";
    });
  }
  if (Array.isArray(value)) {
    return value.map(substituteEnvVars);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = substituteEnvVars(v);
    }
    return result;
  }
  return value;
}

// --- Loader ---

/**
 * Load and validate agents.yaml and platform.yaml from the given config directory.
 * Performs env-var substitution and Zod validation.
 */
export function loadConfig(configDir: string): {
  agents: AgentsConfig;
  platform: PlatformConfig;
} {
  const agentsRaw = yaml.load(
    readFileSync(join(configDir, "agents.yaml"), "utf-8")
  );
  const platformRaw = yaml.load(
    readFileSync(join(configDir, "platform.yaml"), "utf-8")
  );

  const agentsSub = substituteEnvVars(agentsRaw);
  const platformSub = substituteEnvVars(platformRaw);

  const agents = agentsConfigSchema.parse(agentsSub) as AgentsConfig;
  const platform = platformConfigSchema.parse(platformSub) as PlatformConfig;

  return { agents, platform };
}
