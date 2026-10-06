import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GatewayToken } from "../shared/types.js";

const tokens = new Map<string, GatewayToken>();
let storePath: string | null = null;

/**
 * Keep tokens in a file so they survive a proxy restart. A worker gets its
 * token once, when its session starts, and holds it in env for the session's
 * life; with memory-only tokens every restart left live agents with a dead
 * token ("Invalid or expired token") until their session was recycled.
 */
export function initTokenStore(path: string): void {
  storePath = path;
  if (!existsSync(path)) return;
  try {
    const now = Date.now();
    for (const entry of JSON.parse(readFileSync(path, "utf-8")) as GatewayToken[]) {
      if (entry.expiresAt > now) tokens.set(entry.token, entry);
    }
  } catch (err) {
    console.warn(`[tokens] couldn't load ${path}: ${err instanceof Error ? err.message : err}`);
  }
}

function persist(): void {
  if (!storePath) return;
  try {
    const now = Date.now();
    const live = [...tokens.values()].filter((t) => t.expiresAt > now);
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(`${storePath}.tmp`, JSON.stringify(live), { mode: 0o600 });
    renameSync(`${storePath}.tmp`, storePath);
  } catch (err) {
    console.warn(`[tokens] couldn't save ${storePath}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Issue a new gateway token for an agent.
 */
export function issueToken(
  agentId: string,
  credentials: string[],
  storeKeys: string[] | undefined,
  ttl: number
): GatewayToken {
  const token = `apw-${agentId}-${randomBytes(16).toString("hex")}`;
  const entry: GatewayToken = {
    token,
    agentId,
    credentials,
    storeKeys,
    expiresAt: Date.now() + ttl * 1000,
  };
  tokens.set(token, entry);
  persist();
  return entry;
}

/**
 * Validate a token string. Returns the token data if valid and not expired, null otherwise.
 */
export function validateToken(
  token: string
): Omit<GatewayToken, "token"> | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    tokens.delete(token);
    persist();
    return null;
  }
  return {
    agentId: entry.agentId,
    credentials: entry.credentials,
    storeKeys: entry.storeKeys,
    expiresAt: entry.expiresAt,
  };
}

/**
 * Check if a token grants access to a specific credential key.
 * Supports glob patterns (e.g. "*") in the credentials array.
 */
export function checkCredentialScope(
  token: string,
  key: string
): boolean {
  const entry = tokens.get(token);
  if (!entry || entry.expiresAt <= Date.now()) return false;
  return entry.credentials.some((pattern) => globMatch(pattern, key));
}

/**
 * Check if a token allows storing a credential under the given key.
 * Omitted/empty storeKeys = unrestricted (write any key). Non-empty = glob
 * match against the patterns. The threat model for write is weaker than
 * read — an agent supplying a value can't exfiltrate something it didn't
 * already have — so the default is permissive.
 */
export function checkStoreScope(
  token: string,
  key: string
): boolean {
  const entry = tokens.get(token);
  if (!entry || entry.expiresAt <= Date.now()) return false;
  if (!entry.storeKeys?.length) return true;
  return entry.storeKeys.some((pattern) => globMatch(pattern, key));
}

/**
 * Revoke a token.
 */
export function revokeToken(token: string): void {
  if (tokens.delete(token)) persist();
}

/** Visible for testing — clear all tokens and detach the file store */
export function clearAllTokens(): void {
  tokens.clear();
  storePath = null;
}

function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexStr = "^" + escaped.replace(/\*/g, "[^]*") + "$";
  return new RegExp(regexStr).test(value);
}
