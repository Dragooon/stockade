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
 * List all credential titles available in the vault.
 * Returns raw item titles from the provider's `list` command output (JSON array
 * with `title` fields). Returns an empty array if no list command is configured.
 */
export async function listCredentials(provider: Provider): Promise<string[]> {
  if (!provider.list) return [];
  const output = await execProviderCommand(provider.list, provider);
  const items: Array<{ title: string }> = JSON.parse(output);
  return items.map((item) => item.title);
}

/**
 * Store a credential via the provider's `update` command.
 * Falls back to `write` if update fails (key doesn't exist yet).
 * Invalidates the cache entry on success.
 *
 * The agent-supplied value is passed via the APW_STORE_VALUE env var rather
 * than substituted into the command text, so a value containing shell metas
 * (`;`, backticks, `$(...)`, etc.) cannot escape into command position.
 * Templates reference it as `"$APW_STORE_VALUE"`.
 *
 * The key IS substituted as text — the gateway endpoint validates the key
 * against a safe charset before reaching here.
 */
export async function storeCredential(
  provider: Provider,
  key: string,
  value: string
): Promise<void> {
  if (!provider.update && !provider.write) {
    throw new Error("Provider has no write or update command configured");
  }

  const extraEnv = { APW_STORE_VALUE: value };

  if (provider.update) {
    const updateCmd = provider.update.replace(/\{key\}/g, key);
    try {
      await execProviderCommand(updateCmd, provider, extraEnv);
    } catch {
      if (!provider.write) throw new Error("Provider update failed and no write command configured");
      const writeCmd = provider.write.replace(/\{key\}/g, key);
      await execProviderCommand(writeCmd, provider, extraEnv);
    }
  } else {
    const writeCmd = provider.write!.replace(/\{key\}/g, key);
    await execProviderCommand(writeCmd, provider, extraEnv);
  }

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
  const { spawn } = await import("node:child_process");
  const bash = process.platform === "win32"
    ? "C:\\Program Files\\Git\\usr\\bin\\bash.exe"
    : "bash";
  // Stdin must be ignored (not the default pipe). Some provider CLIs (notably
  // `op item edit`) probe stdin for a JSON template; with a connected-but-empty
  // pipe they hang or error. Closing fd 0 makes them fall back to positional
  // arguments. We use spawn (not execFile) because execFile silently overrides
  // stdio:["ignore", ...] and connects stdin anyway on Windows.
  return await new Promise<string>((resolve, reject) => {
    const opts: any = { stdio: ["ignore", "pipe", "pipe"] };
    if (env) opts.env = env;
    const child = spawn(bash, ["-c", cmd], opts);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => { stdout += d.toString(); });
    child.stderr!.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const err: any = new Error(`Command failed (exit ${code}): ${cmd}\n${stderr}`);
        err.stderr = stderr;
        err.exitCode = code;
        reject(err);
      }
    });
  });
}

/**
 * Execute a provider command with optional session injection and retry.
 *
 * If the provider has `signin` + `session_env` configured, the session token
 * is obtained once and injected into every child process.  On auth-like errors,
 * the session is refreshed and the command retried once.
 */
async function execProviderCommand(
  cmd: string,
  provider: Provider,
  extraEnv?: NodeJS.ProcessEnv
): Promise<string> {
  const hasSignin = provider.signin && provider.session_env;

  let env: NodeJS.ProcessEnv | undefined;
  if (hasSignin || extraEnv) {
    env = { ...process.env, ...extraEnv };
    if (hasSignin) {
      try {
        const token = await ensureSession(provider);
        env[provider.session_env!] = token;
      } catch (err) {
        console.warn(`[credentials] signin failed, running command without session: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  try {
    return await execShell(cmd, env);
  } catch (err: any) {
    if (hasSignin) {
      const msg = err?.stderr ?? err?.message ?? "";
      if (/not.*sign|session.*expir|401|auth/i.test(msg)) {
        invalidateSession();
        const token = await ensureSession(provider);
        const retryEnv = { ...process.env, ...extraEnv, [provider.session_env!]: token };
        return execShell(cmd, retryEnv);
      }
    }
    throw err;
  }
}
