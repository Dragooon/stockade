import type { Provider, CachedCredential } from "./types.js";

const cache = new Map<string, CachedCredential>();

/**
 * Resolve a credential value by executing the provider's `read` command.
 * Checks per-key overrides first (first match wins), then falls back
 * to the default read command. Results are cached with the configured TTL.
 */
export async function resolveCredential(
  provider: Provider,
  key: string
): Promise<string> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  // Check overrides first (first match wins)
  let readCmd = provider.read;
  let cacheTtl = provider.cache_ttl;
  if (provider.overrides) {
    for (const override of provider.overrides) {
      if (globMatch(override.match, key)) {
        readCmd = override.read;
        if (override.cache_ttl !== undefined) cacheTtl = override.cache_ttl;
        break;
      }
    }
  }

  const cmd = readCmd.replace(/\{key\}/g, key);
  const value = await execProviderCommand(cmd);

  if (cacheTtl > 0) {
    cache.set(key, {
      value,
      expiresAt: Date.now() + cacheTtl * 1000,
    });
  }

  return value;
}

function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexStr = "^" + escaped.replace(/\*/g, "[^]*") + "$";
  return new RegExp(regexStr).test(value);
}

/**
 * Store a credential via the provider's `update` command.
 * Falls back to `write` if update fails (key doesn't exist yet).
 * Invalidates the cache entry on success.
 */
export async function storeCredential(
  provider: Provider,
  key: string,
  value: string
): Promise<void> {
  const updateCmd = provider.update
    .replace(/\{key\}/g, key)
    .replace(/\{value\}/g, value);

  try {
    await execProviderCommand(updateCmd);
  } catch {
    const writeCmd = provider.write
      .replace(/\{key\}/g, key)
      .replace(/\{value\}/g, value);
    await execProviderCommand(writeCmd);
  }

  // Invalidate cache
  cache.delete(key);
}

/**
 * Invalidate a specific cache entry or all entries.
 */
export function invalidateCache(key?: string): void {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}

/** Visible for testing */
export function getCacheSize(): number {
  return cache.size;
}

/**
 * Execute a shell command and return trimmed stdout.
 * Throws on non-zero exit.
 */
async function execProviderCommand(cmd: string): Promise<string> {
  const { execaCommand } = await import("execa");
  const result = await execaCommand(cmd, { shell: true });
  return result.stdout.trim();
}
