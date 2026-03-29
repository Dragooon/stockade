import type { Provider, CachedCredential } from "./types.js";

const cache = new Map<string, CachedCredential>();

/**
 * Resolve a credential value by executing the provider's `read` command.
 * Results are cached in memory with the configured TTL.
 */
export async function resolveCredential(
  provider: Provider,
  key: string
): Promise<string> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const cmd = provider.read.replace(/\{key\}/g, key);
  const value = await execProviderCommand(cmd);

  cache.set(key, {
    value,
    expiresAt: Date.now() + provider.cache_ttl * 1000,
  });

  return value;
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
