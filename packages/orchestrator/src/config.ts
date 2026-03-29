import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import { z } from "zod";
import type { AgentsConfig, PlatformConfig, PathsConfig } from "./types.js";
import {
  containerConfigSchema,
  containersConfigSchema,
} from "./containers/types.js";
import { schedulerConfigSchema } from "./scheduler/types.js";

const gatekeeperConfigSchema = z.object({
  enabled: z.boolean().default(false),
  agent: z.string().describe("Agent ID to use as the gatekeeper (must be defined in agents section)"),
  auto_approve_risk: z.enum(["low", "medium", "high", "critical"]).default("low"),
});

/**
 * Default platform home directory — decoupled from the source repo.
 * All runtime data (agent workspaces, sessions, containers) lives here.
 */
export const PLATFORM_HOME = join(homedir(), ".stockade");

// --- Zod schemas ---

const memoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  autoDream: z.boolean().default(false),
}).default({ enabled: true, autoDream: false });

const agentConfigSchema = z.object({
  model: z.string(),
  system: z.string(),
  system_mode: z.enum(["append", "replace"]).default("replace"),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
  tools: z.array(z.string()).optional(),
  sandboxed: z.boolean().default(false),
  port: z.number().optional(),
  url: z.string().optional(),
  subagents: z.array(z.string()).optional(),
  credentials: z.array(z.string()).optional(),
  store_keys: z.array(z.string()).optional(),
  container: containerConfigSchema.optional(),
  memory: memoryConfigSchema.optional(),
  permissions: z.array(z.string()).optional(),
});

const channelBindingSchema = z.object({
  server: z.string(),
  agent: z.string(),
  channels: z.union([z.string(), z.array(z.string())]),
});

const pathsConfigSchema = z.object({
  data_dir: z.string().optional(),
  agents_dir: z.string().optional(),
  sessions_db: z.string().optional(),
  containers_dir: z.string().optional(),
});

/**
 * Unified config schema — single config.yaml with all sections.
 * The `agents` key sits alongside `channels`, `rbac`, etc.
 */
const unifiedConfigSchema = z.object({
  agents: z.record(z.string(), agentConfigSchema),
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
    roles: z.record(z.string(), z.object({
      permissions: z.array(z.string()),
      deny: z.array(z.string()).optional(),
      allow: z.array(z.string()).optional(),
    })),
    users: z.record(
      z.string(),
      z.object({
        roles: z.array(z.string()),
        identities: z.record(z.string(), z.string()),
      })
    ),
  }),
  containers: containersConfigSchema.optional(),
  scheduler: schedulerConfigSchema.optional(),
  paths: pathsConfigSchema.optional(),
  gatekeeper: gatekeeperConfigSchema.optional(),
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
 * Resolve all platform paths.
 *
 * Defaults (when paths section is omitted):
 *   data_dir       → ~/.stockade
 *   agents_dir     → ~/.stockade/agents
 *   sessions_db    → ~/.stockade/sessions.db
 *   containers_dir → ~/.stockade/containers
 *   config_dir     → set at runtime from loadConfig's configDir arg
 *
 * When paths ARE provided in config, relative paths are resolved against
 * `projectRoot`. Absolute paths are used as-is.
 */
export function resolvePaths(
  raw: { data_dir?: string; agents_dir?: string; sessions_db?: string; containers_dir?: string } | undefined,
  configDir: string,
  projectRoot: string
): PathsConfig {
  const r = (p: string) => resolve(projectRoot, p);

  const dataDir = raw?.data_dir ? r(raw.data_dir) : PLATFORM_HOME;
  const agentsDir = raw?.agents_dir ? r(raw.agents_dir) : join(dataDir, "agents");
  const sessionsDb = raw?.sessions_db ? r(raw.sessions_db) : join(dataDir, "sessions.db");
  const containersDir = raw?.containers_dir ? r(raw.containers_dir) : join(dataDir, "containers");

  return {
    data_dir: dataDir,
    agents_dir: agentsDir,
    sessions_db: sessionsDb,
    containers_dir: containersDir,
    config_dir: resolve(configDir),
  };
}

/**
 * Load and validate config from the given directory.
 *
 * Reads a single `config.yaml` that contains all sections (agents, channels,
 * rbac, paths, etc.). Performs env-var substitution, Zod validation, and
 * path resolution.
 *
 * @param configDir    Directory containing config.yaml
 * @param projectRoot  Project root for resolving relative paths (default: configDir/..)
 */
export function loadConfig(configDir: string, projectRoot?: string): {
  agents: AgentsConfig;
  platform: PlatformConfig;
} {
  const root = projectRoot ?? resolve(configDir, "..");
  const configPath = join(configDir, "config.yaml");

  const raw = yaml.load(readFileSync(configPath, "utf-8"));
  const substituted = substituteEnvVars(raw);
  const parsed = unifiedConfigSchema.parse(substituted);

  // Split into the two shapes the rest of the codebase expects
  const agents: AgentsConfig = { agents: parsed.agents };
  const platform: PlatformConfig = {
    channels: parsed.channels,
    rbac: parsed.rbac,
    containers: parsed.containers,
    scheduler: parsed.scheduler,
    gatekeeper: parsed.gatekeeper,
  };

  // Resolve paths with smart defaults
  platform.paths = resolvePaths(parsed.paths, configDir, root);

  return { agents, platform };
}
