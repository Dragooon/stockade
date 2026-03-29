import { realpathSync, existsSync } from "node:fs";
import { resolve, basename, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";

// ── Blocked patterns ──
// Paths containing any of these segments are never mounted.
// Mirrors NanoClaw's DEFAULT_BLOCKED_PATTERNS plus extras.

const DEFAULT_BLOCKED_PATTERNS = [
  ".ssh",
  ".gnupg",
  ".gpg",
  ".aws",
  ".azure",
  ".gcloud",
  ".kube",
  ".docker",
  "credentials",
  ".env",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  "private_key",
  ".secret",
];

// ── Types ──

export interface MountAllowlist {
  /** Directories that can be mounted into containers */
  allowedRoots: AllowedRoot[];
  /** Additional glob patterns for paths that should never be mounted */
  blockedPatterns: string[];
  /** If true, non-main agents can only mount read-only regardless of config */
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  /** Absolute path or ~ for home (e.g., "~/projects", "/var/repos") */
  path: string;
  /** Whether read-write mounts are allowed under this root */
  allowReadWrite: boolean;
  /** Optional description for documentation */
  description?: string;
}

export interface MountRequest {
  /** Absolute path on host (supports ~ for home) */
  hostPath: string;
  /** Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value} */
  containerPath?: string;
  /** Default: true for safety */
  readonly?: boolean;
}

export interface MountValidationResult {
  allowed: boolean;
  reason: string;
  realHostPath?: string;
  resolvedContainerPath?: string;
  effectiveReadonly?: boolean;
}

export interface ValidatedMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

// ── Helpers ──

/**
 * Expand ~ to home directory and resolve to absolute path.
 */
export function expandPath(p: string): string {
  const home = process.env.HOME || homedir();
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(home, p.slice(2));
  }
  return resolve(p);
}

/**
 * Get real path resolving symlinks. Returns null if path doesn't exist.
 */
function getRealPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Check if a path matches any blocked pattern.
 * Returns the matched pattern or null.
 */
export function matchesBlockedPattern(
  realPath: string,
  blockedPatterns: string[]
): string | null {
  // Normalize to forward slashes for consistent matching
  const normalized = realPath.replace(/\\/g, "/");
  const parts = normalized.split("/");

  for (const pattern of blockedPatterns) {
    // Check if any path component matches
    for (const part of parts) {
      if (part === pattern || part.includes(pattern)) {
        return pattern;
      }
    }
  }
  return null;
}

/**
 * Check if a real path is under an allowed root.
 * Returns the matching root or null.
 */
function findAllowedRoot(
  realPath: string,
  allowedRoots: AllowedRoot[]
): AllowedRoot | null {
  for (const root of allowedRoots) {
    const expandedRoot = expandPath(root.path);
    const realRoot = getRealPath(expandedRoot);
    if (realRoot === null) continue;

    const rel = relative(realRoot, realPath);
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      return root;
    }
  }
  return null;
}

/**
 * Validate a container path to prevent escaping /workspace/extra/.
 */
function isValidContainerPath(containerPath: string): boolean {
  if (containerPath.includes("..")) return false;
  if (containerPath.startsWith("/")) return false;
  if (!containerPath || containerPath.trim() === "") return false;
  return true;
}

/**
 * Merge default blocked patterns with user-provided ones (deduped).
 */
export function mergeBlockedPatterns(extra: string[]): string[] {
  return [...new Set([...DEFAULT_BLOCKED_PATTERNS, ...extra])];
}

// ── Validation ──

/**
 * Validate a single mount request against the allowlist.
 */
export function validateMount(
  mount: MountRequest,
  allowlist: MountAllowlist,
  isPrivileged: boolean
): MountValidationResult {
  // Derive containerPath from hostPath basename if not specified
  const containerPath = mount.containerPath || basename(mount.hostPath);

  // Validate container path
  if (!isValidContainerPath(containerPath)) {
    return {
      allowed: false,
      reason: `Invalid container path: "${containerPath}" — must be relative, non-empty, and not contain ".."`,
    };
  }

  // Expand and resolve the host path
  const expandedPath = expandPath(mount.hostPath);
  const realPath = getRealPath(expandedPath);

  if (realPath === null) {
    return {
      allowed: false,
      reason: `Host path does not exist: "${mount.hostPath}" (expanded: "${expandedPath}")`,
    };
  }

  // Check against blocked patterns (merged default + user)
  const allBlocked = mergeBlockedPatterns(allowlist.blockedPatterns);
  const blockedMatch = matchesBlockedPattern(realPath, allBlocked);
  if (blockedMatch !== null) {
    return {
      allowed: false,
      reason: `Path matches blocked pattern "${blockedMatch}": "${realPath}"`,
    };
  }

  // Check if under an allowed root
  const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
  if (allowedRoot === null) {
    return {
      allowed: false,
      reason: `Path "${realPath}" is not under any allowed root. Allowed roots: ${allowlist.allowedRoots
        .map((r) => expandPath(r.path))
        .join(", ")}`,
    };
  }

  // Determine effective readonly status
  const requestedReadWrite = mount.readonly === false;
  let effectiveReadonly = true;

  if (requestedReadWrite) {
    if (!isPrivileged && allowlist.nonMainReadOnly) {
      effectiveReadonly = true; // Non-privileged forced read-only
    } else if (!allowedRoot.allowReadWrite) {
      effectiveReadonly = true; // Root doesn't allow read-write
    } else {
      effectiveReadonly = false;
    }
  }

  return {
    allowed: true,
    reason: `Allowed under root "${allowedRoot.path}"${
      allowedRoot.description ? ` (${allowedRoot.description})` : ""
    }`,
    realHostPath: realPath,
    resolvedContainerPath: containerPath,
    effectiveReadonly,
  };
}

/**
 * Validate all additional mounts for an agent.
 * Returns only mounts that passed validation. Rejected mounts are logged via
 * the optional onRejected callback.
 */
export function validateAdditionalMounts(
  mounts: MountRequest[],
  allowlist: MountAllowlist,
  isPrivileged: boolean,
  onRejected?: (mount: MountRequest, reason: string) => void
): ValidatedMount[] {
  const validated: ValidatedMount[] = [];

  for (const mount of mounts) {
    const result = validateMount(mount, allowlist, isPrivileged);

    if (result.allowed) {
      validated.push({
        hostPath: result.realHostPath!,
        containerPath: `/workspace/extra/${result.resolvedContainerPath}`,
        readonly: result.effectiveReadonly!,
      });
    } else {
      onRejected?.(mount, result.reason);
    }
  }

  return validated;
}
