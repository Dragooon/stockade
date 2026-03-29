import { consumeRef } from "../gateway/refs.js";
import { validateToken } from "../gateway/tokens.js";
import { resolveCredential } from "../shared/credentials.js";
import type { Provider } from "../shared/types.js";

/**
 * Regex matching apw-ref tokens: apw-ref:<key>:<32-hex-nonce>
 * Key format: [A-Za-z0-9][A-Za-z0-9/_.-]+ (matches the keyFormat regex in types.ts)
 */
const REF_PATTERN = /apw-ref:[A-Za-z0-9][A-Za-z0-9/_.-]+:[0-9a-f]{32}/g;

/** Content types that are definitely binary — skip scanning entirely. */
const BINARY_CONTENT_TYPES = /^(image|video|audio|application\/octet-stream|application\/zip|application\/gzip)/;

export interface RewriteResult {
  body: Buffer;
  replaced: boolean;
}

/**
 * Scan a request body for apw-ref tokens and replace each with the real
 * credential value. Tokens are one-time-use and scope-validated.
 *
 * Only scans text-like bodies. Binary content types are skipped.
 * Returns the original buffer unchanged if no refs are found.
 */
export async function rewriteBody(
  body: Buffer,
  contentType: string,
  provider: Provider,
): Promise<RewriteResult> {
  // Fast path: empty body or binary content type
  if (body.length === 0) return { body, replaced: false };
  if (BINARY_CONTENT_TYPES.test(contentType)) return { body, replaced: false };

  const text = body.toString("utf-8");

  // Fast path: no ref tokens present
  const matches = text.match(REF_PATTERN);
  if (!matches) return { body, replaced: false };

  // Deduplicate (same ref could appear multiple times, though unlikely)
  const uniqueRefs = [...new Set(matches)];

  let result = text;
  let anyReplaced = false;

  for (const refStr of uniqueRefs) {
    const ref = consumeRef(refStr);
    if (!ref) {
      console.warn(`[body-rewriter] invalid/expired/consumed ref: ${refStr.slice(0, 40)}...`);
      continue;
    }

    // Validate the issuing gateway token is still valid
    if (!validateToken(ref.gatewayToken)) {
      console.warn(`[body-rewriter] gateway token revoked for ref: ${refStr.slice(0, 40)}...`);
      continue;
    }

    // Resolve the real credential
    const value = await resolveCredential(provider, ref.credentialKey);

    // Literal string replacement (no regex to avoid $-escaping issues)
    result = replaceAll(result, refStr, value);
    anyReplaced = true;
  }

  if (!anyReplaced) return { body, replaced: false };
  return { body: Buffer.from(result, "utf-8"), replaced: true };
}

/** Safe literal string replacement (avoids regex special char issues). */
function replaceAll(source: string, search: string, replacement: string): string {
  let result = "";
  let pos = 0;
  while (true) {
    const idx = source.indexOf(search, pos);
    if (idx === -1) {
      result += source.slice(pos);
      break;
    }
    result += source.slice(pos, idx) + replacement;
    pos = idx + search.length;
  }
  return result;
}
