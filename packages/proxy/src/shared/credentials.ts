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
  const value = await execProviderCommand(cmd, provider);

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
  if (!provider.update && !provider.write) {
    throw new Error("Provider has no write or update command configured");
  }

  if (provider.update) {
    const updateCmd = provider.update
      .replace(/\{key\}/g, key)
      .replace(/\{value\}/g, value);

    try {
      await execProviderCommand(updateCmd, provider);
    } catch {
      if (!provider.write) throw new Error("Provider update failed and no write command configured");
      const writeCmd = provider.write
        .replace(/\{key\}/g, key)
        .replace(/\{value\}/g, value);
      await execProviderCommand(writeCmd, provider);
    }
  } else {
    const writeCmd = provider.write!
      .replace(/\{key\}/g, key)
      .replace(/\{value\}/g, value);
    await execProviderCommand(writeCmd, provider);
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

// ─── Provider session management ───────────────────────────────────────────
// When a provider defines `signin` + `session_env`, we run the signin command
// once, capture stdout as a session token, and inject it into every child
// process via the named env var.  Completely generic — works for 1Password,
// Vault, custom token endpoints, etc.

let session: string | null = null;
let signinPromise: Promise<string> | null = null;

/**
 * Run the provider's signin command and cache the token.
 * Concurrent callers share the same in-flight promise.
 */
async function ensureSession(provider: Provider): Promise<string> {
  if (session) return session;
  if (signinPromise) return signinPromise;

  signinPromise = (async () => {
    const token = await execShell(provider.signin!);
    if (!token) throw new Error("Provider signin command returned empty output");
    session = token;
    signinPromise = null;
    return token;
  })();

  return signinPromise;
}

/**
 * Invalidate the cached provider session (e.g. after an auth error).
 */
export function invalidateSession(): void {
  session = null;
  signinPromise = null;
}

/**
 * Execute a shell command and return trimmed stdout. Throws on non-zero exit.
 */
async function execShell(cmd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const bash = process.platform === "win32"
    ? "C:\\Program Files\\Git\\usr\\bin\\bash.exe"
    : "bash";
  const opts = env ? { env } : undefined;
  const { stdout } = await execFileAsync(bash, ["-c", cmd], opts);
  return String(stdout).trim();
}

/**
 * Execute a provider command with optional session injection and retry.
 *
 * If the provider has `signin` + `session_env` configured, the session token
 * is obtained once and injected into every child process.  On auth-like errors,
 * the session is refreshed and the command retried once.
 */
async function execProviderCommand(cmd: string, provider: Provider): Promise<string> {
  const hasSignin = provider.signin && provider.session_env;

  let env: NodeJS.ProcessEnv | undefined;
  if (hasSignin) {
    try {
      const token = await ensureSession(provider);
      env = { ...process.env, [provider.session_env!]: token };
    } catch (err) {
      console.warn(`[credentials] signin failed, running command without session: ${err instanceof Error ? err.message : err}`);
    }
  }

  try {
    return await execShell(cmd, env);
  } catch (err: any) {
    // On auth errors, refresh session and retry once
    if (hasSignin) {
      const msg = err?.stderr ?? err?.message ?? "";
      if (/not.*sign|session.*expir|401|auth/i.test(msg)) {
        invalidateSession();
        const token = await ensureSession(provider);
        const retryEnv = { ...process.env, [provider.session_env!]: token };
        return execShell(cmd, retryEnv);
      }
    }
    throw err;
  }
}
