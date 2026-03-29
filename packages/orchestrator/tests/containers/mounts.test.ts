import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  validateMount,
  validateAdditionalMounts,
  expandPath,
  matchesBlockedPattern,
  mergeBlockedPatterns,
  type MountAllowlist,
  type MountRequest,
} from "../../src/containers/mounts.js";

// Create a real temp dir structure for tests
let tempDir: string;
let projectsDir: string;
let reposDir: string;
let sshDir: string;
let secretFile: string;

function makeAllowlist(overrides?: Partial<MountAllowlist>): MountAllowlist {
  return {
    allowedRoots: [
      { path: projectsDir, allowReadWrite: true, description: "Projects" },
      { path: reposDir, allowReadWrite: false, description: "Repos (read-only)" },
    ],
    blockedPatterns: [],
    nonMainReadOnly: true,
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mount-test-"));
  projectsDir = join(tempDir, "projects");
  reposDir = join(tempDir, "repos");
  sshDir = join(tempDir, ".ssh");

  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(join(projectsDir, "my-app"), { recursive: true });
  mkdirSync(reposDir, { recursive: true });
  mkdirSync(join(reposDir, "lib"), { recursive: true });
  mkdirSync(sshDir, { recursive: true });

  secretFile = join(tempDir, "credentials");
  writeFileSync(secretFile, "super-secret");
  writeFileSync(join(sshDir, "id_rsa"), "private-key");
});

// ── expandPath ──

describe("expandPath", () => {
  it("expands ~ to home directory", () => {
    const result = expandPath("~/projects");
    const home = process.env.HOME || require("os").homedir();
    expect(result).toBe(resolve(home, "projects"));
  });

  it("returns absolute paths unchanged", () => {
    expect(expandPath("/var/data")).toBe(resolve("/var/data"));
  });

  it("resolves relative paths", () => {
    const result = expandPath("relative/path");
    expect(result).toBe(resolve("relative/path"));
  });
});

// ── matchesBlockedPattern ──

describe("matchesBlockedPattern", () => {
  it("matches exact path component", () => {
    expect(matchesBlockedPattern("/home/user/.ssh/keys", [".ssh"])).toBe(".ssh");
  });

  it("matches substring in component", () => {
    expect(matchesBlockedPattern("/home/user/credentials.json", ["credentials"])).toBe(
      "credentials"
    );
  });

  it("returns null when no match", () => {
    expect(matchesBlockedPattern("/home/user/projects/app", [".ssh", ".aws"])).toBeNull();
  });

  it("matches .env pattern", () => {
    expect(matchesBlockedPattern("/home/user/project/.env", [".env"])).toBe(".env");
  });

  it("handles Windows-style paths", () => {
    expect(
      matchesBlockedPattern("C:\\Users\\user\\.ssh\\key", [".ssh"])
    ).toBe(".ssh");
  });
});

// ── mergeBlockedPatterns ──

describe("mergeBlockedPatterns", () => {
  it("merges defaults with extras, deduped", () => {
    const merged = mergeBlockedPatterns(["custom", ".ssh"]);
    expect(merged).toContain("custom");
    expect(merged).toContain(".ssh");
    // No duplicates
    expect(merged.filter((p) => p === ".ssh").length).toBe(1);
  });

  it("includes all default patterns", () => {
    const merged = mergeBlockedPatterns([]);
    expect(merged).toContain(".ssh");
    expect(merged).toContain(".gnupg");
    expect(merged).toContain(".aws");
    expect(merged).toContain(".env");
    expect(merged).toContain("id_rsa");
    expect(merged).toContain("private_key");
    expect(merged.length).toBeGreaterThanOrEqual(16);
  });
});

// ── validateMount ──

describe("validateMount", () => {
  it("allows a path under an allowed root", () => {
    const mount: MountRequest = { hostPath: join(projectsDir, "my-app") };
    const result = validateMount(mount, makeAllowlist(), true);

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("Projects");
    expect(result.resolvedContainerPath).toBe("my-app");
    expect(result.effectiveReadonly).toBe(true); // default readonly
  });

  it("allows read-write when root permits and privileged", () => {
    const mount: MountRequest = {
      hostPath: join(projectsDir, "my-app"),
      readonly: false,
    };
    const result = validateMount(mount, makeAllowlist(), true);

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it("forces read-only for non-privileged agents when nonMainReadOnly is true", () => {
    const mount: MountRequest = {
      hostPath: join(projectsDir, "my-app"),
      readonly: false,
    };
    const result = validateMount(mount, makeAllowlist(), false);

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it("forces read-only when root disallows read-write", () => {
    const mount: MountRequest = {
      hostPath: join(reposDir, "lib"),
      readonly: false,
    };
    const result = validateMount(mount, makeAllowlist(), true);

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it("rejects paths not under any allowed root", () => {
    const mount: MountRequest = { hostPath: tempDir };
    const result = validateMount(mount, makeAllowlist(), true);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not under any allowed root");
  });

  it("rejects paths matching blocked patterns", () => {
    const mount: MountRequest = { hostPath: sshDir };
    const allowlist = makeAllowlist({
      allowedRoots: [{ path: tempDir, allowReadWrite: false }],
    });
    const result = validateMount(mount, allowlist, true);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked pattern ".ssh"');
  });

  it("rejects paths matching credentials blocked pattern", () => {
    const mount: MountRequest = { hostPath: secretFile };
    const allowlist = makeAllowlist({
      allowedRoots: [{ path: tempDir, allowReadWrite: false }],
    });
    const result = validateMount(mount, allowlist, true);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("credentials");
  });

  it("rejects non-existent paths", () => {
    const mount: MountRequest = { hostPath: join(projectsDir, "nonexistent") };
    const result = validateMount(mount, makeAllowlist(), true);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("does not exist");
  });

  it("rejects container path with ..", () => {
    const mount: MountRequest = {
      hostPath: join(projectsDir, "my-app"),
      containerPath: "../escape",
    };
    const result = validateMount(mount, makeAllowlist(), true);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Invalid container path");
  });

  it("rejects absolute container path", () => {
    const mount: MountRequest = {
      hostPath: join(projectsDir, "my-app"),
      containerPath: "/absolute/path",
    };
    const result = validateMount(mount, makeAllowlist(), true);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Invalid container path");
  });

  it("rejects empty container path", () => {
    const mount: MountRequest = {
      hostPath: join(projectsDir, "my-app"),
      containerPath: "  ",
    };
    const result = validateMount(mount, makeAllowlist(), true);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Invalid container path");
  });

  it("uses custom container path when provided", () => {
    const mount: MountRequest = {
      hostPath: join(projectsDir, "my-app"),
      containerPath: "custom-name",
    };
    const result = validateMount(mount, makeAllowlist(), true);

    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe("custom-name");
  });

  it("respects extra blocked patterns from allowlist", () => {
    const mount: MountRequest = { hostPath: join(projectsDir, "my-app") };
    const allowlist = makeAllowlist({
      blockedPatterns: ["my-app"],
    });
    const result = validateMount(mount, allowlist, true);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("my-app");
  });

  it("allows non-privileged read-only when nonMainReadOnly is false", () => {
    const mount: MountRequest = {
      hostPath: join(projectsDir, "my-app"),
      readonly: false,
    };
    const allowlist = makeAllowlist({ nonMainReadOnly: false });
    const result = validateMount(mount, allowlist, false);

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });
});

// ── validateAdditionalMounts ──

describe("validateAdditionalMounts", () => {
  it("returns only valid mounts", () => {
    const mounts: MountRequest[] = [
      { hostPath: join(projectsDir, "my-app") },
      { hostPath: join(tempDir, "nonexistent") },
      { hostPath: join(reposDir, "lib") },
    ];

    const validated = validateAdditionalMounts(mounts, makeAllowlist(), true);

    expect(validated).toHaveLength(2);
    expect(validated[0].containerPath).toBe("/workspace/extra/my-app");
    expect(validated[1].containerPath).toBe("/workspace/extra/lib");
  });

  it("calls onRejected for rejected mounts", () => {
    const rejected: Array<{ mount: MountRequest; reason: string }> = [];
    const mounts: MountRequest[] = [
      { hostPath: join(tempDir, "nonexistent") },
      { hostPath: sshDir },
    ];

    const allowlist = makeAllowlist({
      allowedRoots: [{ path: tempDir, allowReadWrite: false }],
    });

    validateAdditionalMounts(mounts, allowlist, true, (mount, reason) => {
      rejected.push({ mount, reason });
    });

    expect(rejected).toHaveLength(2);
    expect(rejected[0].reason).toContain("does not exist");
    expect(rejected[1].reason).toContain(".ssh");
  });

  it("formats container paths with /workspace/extra/ prefix", () => {
    const mounts: MountRequest[] = [
      { hostPath: join(projectsDir, "my-app"), containerPath: "app" },
    ];

    const validated = validateAdditionalMounts(mounts, makeAllowlist(), true);
    expect(validated[0].containerPath).toBe("/workspace/extra/app");
  });

  it("returns empty array when all mounts are rejected", () => {
    const mounts: MountRequest[] = [
      { hostPath: join(tempDir, "nonexistent") },
    ];
    const validated = validateAdditionalMounts(mounts, makeAllowlist(), true);
    expect(validated).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    const validated = validateAdditionalMounts([], makeAllowlist(), true);
    expect(validated).toHaveLength(0);
  });
});
