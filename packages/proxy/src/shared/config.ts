import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import { ProxyConfigFileSchema, type ProxyConfig } from "./types.js";

/**
 * Expand `~` prefix to the user's home directory.
 */
function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Load and validate proxy.yaml from the given config directory.
 * Resolves file paths (TLS certs, SSH CA) relative to configDir
 * and expands `~` prefixes.
 */
export function loadProxyConfig(configDir: string): ProxyConfig {
  const filePath = resolve(configDir, "proxy.yaml");
  const raw = readFileSync(filePath, "utf-8");
  const parsed = yaml.load(raw) as Record<string, unknown>;
  const validated = ProxyConfigFileSchema.parse(parsed);
  const config = validated.proxy;

  // Resolve file paths relative to configDir (or absolute / ~-prefixed)
  const resolvePath = (p: string) => {
    const expanded = expandHome(p);
    return resolve(configDir, expanded);
  };

  config.http.tls.ca_cert = resolvePath(config.http.tls.ca_cert);
  config.http.tls.ca_key = resolvePath(config.http.tls.ca_key);
  config.ssh.ca_key = resolvePath(config.ssh.ca_key);

  return config;
}
