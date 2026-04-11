import { z } from "zod";

// ─── Key format ─────────────────────────────────────────────────
/** Credential keys must be structured paths like AgentVault/GitHub/token */
const keyFormat = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9/_.-]+$/,
  "Key must match: ^[A-Za-z0-9][A-Za-z0-9/_.-]+$"
);

// ─── Policy ─────────────────────────────────────────────────────
export const PolicyRuleSchema = z.object({
  host: z.string(),
  port: z.number().int().positive().optional(),
  path: z.string().optional(),
  method: z.string().optional(),
  action: z.enum(["allow", "deny"]),
});

export const PolicySchema = z.object({
  default: z.enum(["allow", "deny"]),
  rules: z.array(PolicyRuleSchema),
});

// ─── HTTP ───────────────────────────────────────────────────────
export const HttpInjectSchema = z.object({
  header: z.string(),
  format: z.string().optional(),
});

export const HttpRouteSchema = z.object({
  host: z.string(),
  path: z.string().optional(),
  method: z.string().optional(),
  credential: keyFormat,
  inject: HttpInjectSchema,
});

export const HttpConfigSchema = z.object({
  port: z.number().int().positive().default(10255),
  tls: z.object({
    ca_cert: z.string(),
    ca_key: z.string(),
  }),
  strip_headers: z.array(z.string()).default(["authorization", "x-api-key", "proxy-authorization"]),
  routes: z.array(HttpRouteSchema),
});

// ─── SSH ────────────────────────────────────────────────────────
export const SshRouteSchema = z.object({
  host: z.string(),
  credential: keyFormat,
  user: z.string(),
  port: z.number().int().positive().default(22),
});

export const SshConfigSchema = z.object({
  port: z.number().int().positive().default(10022),
  ca_key: z.string(),
  routes: z.array(SshRouteSchema),
});

// ─── Provider ───────────────────────────────────────────────────
const ProviderOverrideSchema = z.object({
  /** Glob pattern matched against the credential key. First match wins. */
  match: z.string(),
  read: z.string(),
  /** Per-key cache TTL override (seconds). Use 0 to disable caching for volatile credentials like OAuth tokens. */
  cache_ttl: z.number().nonnegative().optional(),
});

export const ProviderSchema = z.object({
  read: z.string(),
  /** Shell command to create a new credential. Only needed for gateway/store. */
  write: z.string().optional(),
  /** Shell command to update an existing credential. Only needed for gateway/store. */
  update: z.string().optional(),
  /**
   * Shell command to obtain a session token (run once, stdout captured).
   * The token is injected into every subsequent command via `session_env`.
   * If the command fails or returns empty, commands run without a session.
   */
  signin: z.string().optional(),
  /** Env var name to inject the signin token as (required when `signin` is set). */
  session_env: z.string().optional(),
  cache_ttl: z.number().nonnegative().default(300),
  /** Per-key overrides — checked before the default `read` command. */
  overrides: z.array(ProviderOverrideSchema).default([]),
}).refine(
  (p) => !p.signin || p.session_env,
  { message: "session_env is required when signin is set", path: ["session_env"] },
);

// ─── Gateway ────────────────────────────────────────────────────
export const GatewaySchema = z.object({
  port: z.number().int().positive().default(10256),
  token_ttl: z.number().positive().default(86400),
  /** TTL for credential reference tokens (seconds). Default: 5 minutes. */
  ref_ttl: z.number().positive().default(300),
});

// ─── Top-level ProxyConfig ──────────────────────────────────────
export const ProxyConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  provider: ProviderSchema,
  policy: PolicySchema,
  http: HttpConfigSchema,
  ssh: SshConfigSchema,
  gateway: GatewaySchema,
});

/** Wraps the top-level `proxy:` key in the YAML */
export const ProxyConfigFileSchema = z.object({
  proxy: ProxyConfigSchema,
});

// ─── Inferred types ─────────────────────────────────────────────
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type HttpInject = z.infer<typeof HttpInjectSchema>;
export type HttpRoute = z.infer<typeof HttpRouteSchema>;
export type HttpConfig = z.infer<typeof HttpConfigSchema>;
export type SshRoute = z.infer<typeof SshRouteSchema>;
export type SshConfig = z.infer<typeof SshConfigSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type GatewayConfig = z.infer<typeof GatewaySchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

// ─── Runtime types (not in YAML) ────────────────────────────────
export interface CachedCredential {
  value: string;
  expiresAt: number;
}

export interface GatewayToken {
  token: string;
  agentId: string;
  credentials: string[];
  storeKeys?: string[];
  expiresAt: number;
}

/** An opaque reference token that stands in for a real credential in request bodies. */
export interface RefToken {
  /** The full ref string: "apw-ref:<key>:<nonce>" */
  ref: string;
  /** The credential key this ref resolves to */
  credentialKey: string;
  /** The gateway token that issued this ref (for scope validation) */
  gatewayToken: string;
  /** Absolute timestamp (ms) when this ref expires */
  expiresAt: number;
  /** Whether this ref has been consumed (one-time use) */
  consumed: boolean;
}

/** Request context for policy evaluation */
export interface PolicyRequest {
  host: string;
  port?: number;
  path?: string;
  method?: string;
}
