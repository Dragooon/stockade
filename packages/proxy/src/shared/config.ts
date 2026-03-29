import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { ProxyConfigFileSchema, type ProxyConfig } from "./types.js";

/**
 * Load and validate proxy.yaml from the given config directory.
 * Returns the validated ProxyConfig.
 */
export function loadProxyConfig(configDir: string): ProxyConfig {
  const filePath = resolve(configDir, "proxy.yaml");
  const raw = readFileSync(filePath, "utf-8");
  const parsed = yaml.load(raw) as Record<string, unknown>;
  const validated = ProxyConfigFileSchema.parse(parsed);
  return validated.proxy;
}
