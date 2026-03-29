import { randomBytes } from "node:crypto";
import type { GatewayToken } from "../shared/types.js";

const tokens = new Map<string, GatewayToken>();

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
 */
export function checkCredentialScope(
  token: string,
  key: string
): boolean {
  const entry = tokens.get(token);
  if (!entry || entry.expiresAt <= Date.now()) return false;
  return entry.credentials.includes(key);
}

/**
 * Check if a token allows storing a credential under the given key.
 * Uses glob matching against the token's storeKeys patterns.
 */
export function checkStoreScope(
  token: string,
  key: string
): boolean {
  const entry = tokens.get(token);
  if (!entry || entry.expiresAt <= Date.now()) return false;
  if (!entry.storeKeys?.length) return false;
  return entry.storeKeys.some((pattern) => globMatch(pattern, key));
}

/**
 * Revoke a token.
 */
export function revokeToken(token: string): void {
  tokens.delete(token);
}

/** Visible for testing — clear all tokens */
export function clearAllTokens(): void {
  tokens.clear();
}

function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexStr = "^" + escaped.replace(/\*/g, "[^]*") + "$";
  return new RegExp(regexStr).test(value);
}
