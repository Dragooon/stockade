import { z } from "zod";

// ── Container-specific config per agent (optional in agents.yaml) ──

export const containerConfigSchema = z.object({
  dockerfile: z.string().optional(),
  isolation: z.enum(["shared", "session"]).default("shared"),
  memory: z.string().optional(),
  cpus: z.number().optional(),
  volumes: z.array(z.string()).optional(),
  workspace_path: z.string().optional(),
  workspace_host_path: z.string().optional(),
  /** Override the container user (e.g. "root" to access Docker socket). Defaults to Dockerfile USER. */
  user: z.string().optional(),
});

export type ContainerConfig = z.infer<typeof containerConfigSchema>;

// ── Top-level container settings in platform.yaml ──

const healthCheckSchema = z.object({
  interval_ms: z.number().default(500),
  timeout_ms: z.number().default(30000),
  retries: z.number().default(3),
});

const resourceDefaultsSchema = z.object({
  memory: z.string().default("1g"),
  cpus: z.number().default(1.0),
});

export const containersConfigSchema = z.object({
  network: z.string().default("agent-net"),
  proxy_host: z.string().default("host.docker.internal"),
  port_range: z
    .tuple([z.number(), z.number()])
    .default([3001, 3099]),
  base_dockerfile: z.string().default("./packages/worker/Dockerfile"),
  build_context: z.string().default("."),
  health_check: healthCheckSchema.default({
    interval_ms: 500,
    timeout_ms: 30000,
    retries: 3,
  }),
  defaults: resourceDefaultsSchema.default({
    memory: "1g",
    cpus: 1.0,
  }),
  max_age_hours: z.number().default(0),
  session_idle_minutes: z.number().default(30),
  max_concurrent: z.number().default(5),
  proxy_ca_cert: z.string().default("./data/proxy/ca.crt"),
});

export type ContainersConfig = z.infer<typeof containersConfigSchema>;

// ── Runtime state for a running container ──

export interface ContainerState {
  containerId: string;
  key: string;
  agentId: string;
  scope?: string;
  image: string;
  url: string;
  port: number;
  /** Undefined for containers reconnected after an orchestrator restart. */
  gatewayToken?: string;
  startedAt: number;
  lastActivity: number;
}

// ── Docker client types ──

export interface CreateContainerOpts {
  image: string;
  name: string;
  network: string;
  ports: Record<string, string>;
  env: Record<string, string>;
  volumes: string[];
  labels: Record<string, string>;
  memory?: string;
  cpus?: number;
  addHost?: string[];
  user?: string;
}

export interface ContainerInspect {
  id: string;
  name: string;
  state: { running: boolean; status: string };
  labels: Record<string, string>;
}

export interface ContainerInfo {
  id: string;
  name: string;
  labels: Record<string, string>;
  state: string;
  ports: string;
  /** Short image ID or tag the container was created from. */
  image: string;
}
