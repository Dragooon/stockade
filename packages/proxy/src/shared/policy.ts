import type { Policy, PolicyRule, PolicyRequest } from "./types.js";

/**
 * Evaluate a request against the policy ruleset.
 * First matching rule wins. Falls back to `policy.default`.
 */
export function evaluatePolicy(
  policy: Policy,
  request: PolicyRequest
): "allow" | "deny" {
  for (const rule of policy.rules) {
    if (matchesRule(rule, request)) {
      return rule.action;
    }
  }
  return policy.default;
}

function matchesRule(rule: PolicyRule, request: PolicyRequest): boolean {
  if (!globMatch(rule.host, request.host)) return false;

  if (rule.port !== undefined && request.port !== undefined) {
    if (rule.port !== request.port) return false;
  }

  if (rule.path !== undefined) {
    if (request.path === undefined) return false;
    if (!globMatch(rule.path, request.path)) return false;
  }

  if (rule.method !== undefined) {
    if (request.method === undefined) return false;
    if (rule.method !== "*" && rule.method.toUpperCase() !== request.method.toUpperCase()) {
      return false;
    }
  }

  return true;
}

/**
 * Simple glob matching: supports `*` (any segment) and `**` is not needed
 * since we match individual path segments / hostnames.
 *
 * - `*` alone matches anything
 * - `*.example.com` matches `sub.example.com`
 * - `/repos/* /pulls` matches `/repos/foo/pulls`
 */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;

  // Convert glob to regex:
  // - Escape regex special chars except *
  // - Replace * with [^]* (match anything)
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexStr = "^" + escaped.replace(/\*/g, "[^]*") + "$";
  return new RegExp(regexStr).test(value);
}
