/**
 * E2E tests for mount security — tests real filesystem paths, real symlinks,
 * and real blocked pattern enforcement as a real user would encounter it.
 *
 * All filesystem operations use real temp directories (no mocking).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateMount,
  validateAdditionalMounts,
  matchesBlockedPattern,
  mergeBlockedPatterns,
  type MountAllowlist,
  type MountRequest,
} from "../../src/containers/mounts.js";

// ── Real filesystem setup ────────────────────────────────────────────────────
//
// We build ONE temp tree for the entire suite (beforeAll) so teardown is just
// letting the OS clean the temp dir after the process exits.
//
//  <tmpRoot>/
//    safe/
//      projects/              ← allowed root #1  (read-write)
//        my-app/
//        ssh-client/          ← name contains "ssh" but NOT ".ssh" segment
//        secret-data/         ← used for custom blocked-pattern test
//      repos/                 ← allowed root #2  (read-only)
//        lib/
//    sensitive/
//      .ssh/
//        id_rsa               ← real key file
//        id_ed25519
//      .aws/
//        credentials
//      .gnupg/
//      .docker/
//      .kube/
//      .env                   ← file named .env
//      private_key
//      id_rsa                 ← top-level key file
//      id_ed25519
//      credentials            ← top-level credentials file
//    symlinks/
//      to-blocked  → <sensitive/.ssh>   ← safe name, resolves to blocked
//      to-safe     → <safe/projects>    ← safe → safe
//    nonexistent-root/        ← deliberately NOT created

let tmpRoot: string;
let safeProjects: string;
let safeRepos: string;
let sensitiveDir: string;
let symlinksDir: string;
let nonexistentRoot: string;
let symlinkToBlocked: string;
let symlinkToSafe: string;
let symlinkHop1: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "mount-e2e-"));

  // safe subtree
  safeProjects = join(tmpRoot, "safe", "projects");
  safeRepos = join(tmpRoot, "safe", "repos");
  mkdirSync(join(safeProjects, "my-app"), { recursive: true });
  mkdirSync(join(safeProjects, "nested", "deep", "dir"), { recursive: true });
  mkdirSync(join(safeProjects, "ssh-client"), { recursive: true }); // partial match target
  mkdirSync(join(safeProjects, "secret-data"), { recursive: true }); // custom pattern target
  mkdirSync(join(safeRepos, "lib"), { recursive: true });

  // sensitive subtree — mirrors real locations a user might accidentally expose
  sensitiveDir = join(tmpRoot, "sensitive");
  const sshDir = join(sensitiveDir, ".ssh");
  const awsDir = join(sensitiveDir, ".aws");
  const gnupgDir = join(sensitiveDir, ".gnupg");
  const dockerDir = join(sensitiveDir, ".docker");
  const kubeDir = join(sensitiveDir, ".kube");
  mkdirSync(sshDir, { recursive: true });
  mkdirSync(awsDir, { recursive: true });
  mkdirSync(gnupgDir, { recursive: true });
  mkdirSync(dockerDir, { recursive: true });
  mkdirSync(kubeDir, { recursive: true });

  writeFileSync(join(sshDir, "id_rsa"), "fake-private-key");
  writeFileSync(join(sshDir, "id_ed25519"), "fake-ed25519-key");
  writeFileSync(join(awsDir, "credentials"), "[default]\naws_access_key_id=FAKE");
  writeFileSync(join(sensitiveDir, ".env"), "SECRET=hunter2");
  writeFileSync(join(sensitiveDir, "private_key"), "-----BEGIN PRIVATE KEY-----");
  writeFileSync(join(sensitiveDir, "id_rsa"), "standalone-id_rsa");
  writeFileSync(join(sensitiveDir, "id_ed25519"), "standalone-id_ed25519");
  writeFileSync(join(sensitiveDir, "credentials"), "token=abc123");

  // symlinks subtree
  symlinksDir = join(tmpRoot, "symlinks");
  mkdirSync(symlinksDir, { recursive: true });
  symlinkToBlocked = join(symlinksDir, "to-blocked");
  symlinkToSafe = join(symlinksDir, "to-safe");
  // On Windows, directory symlinks require elevation but "junction" type does not.
  // Use "junction" on win32 so the tests run without UAC prompts.
  const symlinkType = process.platform === "win32" ? "junction" : undefined;
  symlinkSync(sshDir, symlinkToBlocked, symlinkType);       // safe name → blocked target
  symlinkSync(safeProjects, symlinkToSafe, symlinkType);    // safe name → safe target

  // Multi-hop chain: symlink1 → symlink2 → .ssh (hop1 → to-blocked → .ssh)
  symlinkHop1 = join(symlinksDir, "hop1");
  symlinkSync(symlinkToBlocked, symlinkHop1, symlinkType);  // hop1 → to-blocked → .ssh

  // intentionally NOT created — used to test missing root rejection
  nonexistentRoot = join(tmpRoot, "nonexistent-root");
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Helper ───────────────────────────────────────────────────────────────────

/** Build a minimal allowlist with safeProjects (rw) + safeRepos (ro) as roots. */
function makeAllowlist(overrides?: Partial<MountAllowlist>): MountAllowlist {
  return {
    allowedRoots: [
      { path: safeProjects, allowReadWrite: true, description: "Projects RW" },
      { path: safeRepos, allowReadWrite: false, description: "Repos RO" },
    ],
    blockedPatterns: [],
    nonMainReadOnly: false,
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1–11  Blocked patterns — positive detection
// ══════════════════════════════════════════════════════════════════════════════

describe("Blocked patterns — positive detection", () => {
  const allBlocked = mergeBlockedPatterns([]);

  it("1. path containing .ssh segment is blocked", () => {
    const matched = matchesBlockedPattern(
      join(tmpRoot, "sensitive", ".ssh").replace(/\\/g, "/"),
      allBlocked
    );
    expect(matched).toBe(".ssh");
  });

  it("2. path containing .aws segment is blocked", () => {
    const matched = matchesBlockedPattern(
      join(tmpRoot, "sensitive", ".aws").replace(/\\/g, "/"),
      allBlocked
    );
    expect(matched).toBe(".aws");
  });

  it("3. path containing .env segment is blocked", () => {
    const matched = matchesBlockedPattern(
      join(tmpRoot, "sensitive", ".env").replace(/\\/g, "/"),
      allBlocked
    );
    expect(matched).toBe(".env");
  });

  it("4. path containing credentials segment is blocked", () => {
    const matched = matchesBlockedPattern(
      join(tmpRoot, "sensitive", "credentials").replace(/\\/g, "/"),
      allBlocked
    );
    expect(matched).toBe("credentials");
  });

  it("5. path containing id_rsa segment is blocked", () => {
    const matched = matchesBlockedPattern(
      join(tmpRoot, "sensitive", "id_rsa").replace(/\\/g, "/"),
      allBlocked
    );
    expect(matched).toBe("id_rsa");
  });

  it("6. path containing id_ed25519 segment is blocked", () => {
    const matched = matchesBlockedPattern(
      join(tmpRoot, "sensitive", "id_ed25519").replace(/\\/g, "/"),
      allBlocked
    );
    expect(matched).toBe("id_ed25519");
  });

  it("7. path containing private_key segment is blocked", () => {
    const matched = matchesBlockedPattern(
      join(tmpRoot, "sensitive", "private_key").replace(/\\/g, "/"),
      allBlocked
    );
    expect(matched).toBe("private_key");
  });

  it("8. path containing .gnupg segment is blocked", () => {
    const matched = matchesBlockedPattern(
      join(tmpRoot, "sensitive", ".gnupg").replace(/\\/g, "/"),
      allBlocked
    );
    expect(matched).toBe(".gnupg");
  });

  it("9. path containing .docker segment is blocked", () => {
    const matched = matchesBlockedPattern(
      join(tmpRoot, "sensitive", ".docker").replace(/\\/g, "/"),
      allBlocked
    );
    expect(matched).toBe(".docker");
  });

  it("10. path containing .kube segment is blocked", () => {
    const matched = matchesBlockedPattern(
      join(tmpRoot, "sensitive", ".kube").replace(/\\/g, "/"),
      allBlocked
    );
    expect(matched).toBe(".kube");
  });

  it('11. custom blocked pattern "secret-data" blocks the path when added', () => {
    // The directory exists under safeProjects, so it would normally be allowed —
    // the custom pattern is what should trigger the block.
    const patterns = mergeBlockedPatterns(["secret-data"]);
    const matched = matchesBlockedPattern(
      join(safeProjects, "secret-data").replace(/\\/g, "/"),
      patterns
    );
    expect(matched).toBe("secret-data");

    // Also verify via validateMount end-to-end
    const allowlist = makeAllowlist({ blockedPatterns: ["secret-data"] });
    const result = validateMount(
      { hostPath: join(safeProjects, "secret-data") },
      allowlist,
      true
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("secret-data");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 12–13  Blocked patterns — negative (should NOT block)
// ══════════════════════════════════════════════════════════════════════════════

describe("Blocked patterns — negative (should NOT block)", () => {
  const allBlocked = mergeBlockedPatterns([]);

  it("12. /projects/my-app with no blocked segments passes the pattern check", () => {
    const matched = matchesBlockedPattern(
      join(safeProjects, "my-app").replace(/\\/g, "/"),
      allBlocked
    );
    expect(matched).toBeNull();
  });

  it('13. /projects/ssh-client does NOT match .ssh — "ssh-client" does not include the literal ".ssh" string', () => {
    // The implementation uses part.includes(pattern).
    // "ssh-client".includes(".ssh") === false  →  no match expected.
    const matched = matchesBlockedPattern(
      join(safeProjects, "ssh-client").replace(/\\/g, "/"),
      allBlocked
    );
    expect(matched).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 14–19  Allowed roots
// ══════════════════════════════════════════════════════════════════════════════

describe("Allowed roots", () => {
  it("14. path exactly at an allowed root is allowed", () => {
    const result = validateMount({ hostPath: safeProjects }, makeAllowlist(), true);
    expect(result.allowed).toBe(true);
  });

  it("15. path one level under allowed root is allowed", () => {
    const result = validateMount(
      { hostPath: join(safeProjects, "my-app") },
      makeAllowlist(),
      true
    );
    expect(result.allowed).toBe(true);
  });

  it("16. path deeply nested under allowed root is allowed", () => {
    const result = validateMount(
      { hostPath: join(safeProjects, "nested", "deep", "dir") },
      makeAllowlist(),
      true
    );
    expect(result.allowed).toBe(true);
  });

  it("17. path NOT under any allowed root is rejected", () => {
    const result = validateMount({ hostPath: sensitiveDir }, makeAllowlist(), true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not under any allowed root");
  });

  it("18. when the allowed root itself does not exist, paths under it are rejected", () => {
    const allowlist = makeAllowlist({
      allowedRoots: [{ path: nonexistentRoot, allowReadWrite: true }],
    });
    // The path we try to mount must also exist so we isolate the root-not-found case
    const result = validateMount({ hostPath: safeProjects }, allowlist, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not under any allowed root");
  });

  it("19. multiple allowed roots — path under second root passes", () => {
    // makeAllowlist puts safeRepos as the second root
    const result = validateMount(
      { hostPath: join(safeRepos, "lib") },
      makeAllowlist(),
      true
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("Repos RO");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 20–23  Path traversal prevention (container path validation)
// ══════════════════════════════════════════════════════════════════════════════

describe("Path traversal prevention", () => {
  it("20. container path with .. is rejected", () => {
    const result = validateMount(
      {
        hostPath: join(safeProjects, "my-app"),
        containerPath: "../escape",
      },
      makeAllowlist(),
      true
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Invalid container path");
  });

  it('21. container path with absolute "/" prefix is rejected', () => {
    const result = validateMount(
      {
        hostPath: join(safeProjects, "my-app"),
        containerPath: "/absolute/path",
      },
      makeAllowlist(),
      true
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Invalid container path");
  });

  it("22. empty / whitespace-only container path is rejected", () => {
    const result = validateMount(
      {
        hostPath: join(safeProjects, "my-app"),
        containerPath: "   ",
      },
      makeAllowlist(),
      true
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Invalid container path");
  });

  it("23. normal relative container path is accepted", () => {
    const result = validateMount(
      {
        hostPath: join(safeProjects, "my-app"),
        containerPath: "my-app",
      },
      makeAllowlist(),
      true
    );
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe("my-app");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 24–25  Symlink resolution
// ══════════════════════════════════════════════════════════════════════════════

describe("Symlink resolution", () => {
  it("24. symlink from safe location → blocked location is REJECTED (real path resolves to .ssh)", () => {
    // symlinkToBlocked = symlinks/to-blocked → sensitive/.ssh
    // The link name itself ("to-blocked") is innocent — but realpathSync
    // follows it to .ssh, which is blocked.
    expect(existsSync(symlinkToBlocked)).toBe(true);

    // Mount the symlink under an allowlist that permits the symlinks dir
    const allowlist = makeAllowlist({
      allowedRoots: [{ path: symlinksDir, allowReadWrite: true }],
    });
    const result = validateMount({ hostPath: symlinkToBlocked }, allowlist, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(".ssh");
  });

  it("25a. multi-hop symlink chain (hop1 → to-blocked → .ssh) is REJECTED", () => {
    // hop1 → to-blocked → .ssh  — realpathSync follows the full chain
    expect(existsSync(symlinkHop1)).toBe(true);

    const allowlist = makeAllowlist({
      allowedRoots: [{ path: symlinksDir, allowReadWrite: true }],
    });
    const result = validateMount({ hostPath: symlinkHop1 }, allowlist, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(".ssh");
  });

  it("25. symlink from safe location → safe location is ALLOWED", () => {
    // symlinkToSafe = symlinks/to-safe → safe/projects
    expect(existsSync(symlinkToSafe)).toBe(true);

    // We allow the symlinks dir AND the resolved target (safeProjects)
    const allowlist = makeAllowlist({
      allowedRoots: [
        { path: symlinksDir, allowReadWrite: true },
        { path: safeProjects, allowReadWrite: true },
      ],
    });
    const result = validateMount({ hostPath: symlinkToSafe }, allowlist, true);
    expect(result.allowed).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 26–29  Read-only enforcement
// ══════════════════════════════════════════════════════════════════════════════

describe("Read-only enforcement", () => {
  it("26. privileged agent + allowReadWrite root → read-write mount", () => {
    // safeProjects has allowReadWrite: true; isPrivileged = true; nonMainReadOnly = false
    const result = validateMount(
      { hostPath: join(safeProjects, "my-app"), readonly: false },
      makeAllowlist({ nonMainReadOnly: false }),
      true
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it("27. privileged agent + read-only root → forced read-only", () => {
    // safeRepos has allowReadWrite: false — even privileged can't get rw
    const result = validateMount(
      { hostPath: join(safeRepos, "lib"), readonly: false },
      makeAllowlist({ nonMainReadOnly: false }),
      true
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it("28. non-privileged agent + nonMainReadOnly=true → forced read-only regardless of root", () => {
    const result = validateMount(
      { hostPath: join(safeProjects, "my-app"), readonly: false },
      makeAllowlist({ nonMainReadOnly: true }),
      false // non-privileged
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it("29. non-privileged agent + nonMainReadOnly=false + allowReadWrite root → read-write", () => {
    // nonMainReadOnly = false AND root allows rw AND agent requests rw → should be rw
    const result = validateMount(
      { hostPath: join(safeProjects, "my-app"), readonly: false },
      makeAllowlist({ nonMainReadOnly: false }),
      false // non-privileged
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 30–34  validateAdditionalMounts batch
// ══════════════════════════════════════════════════════════════════════════════

describe("validateAdditionalMounts batch", () => {
  it("30. mix of valid and invalid mounts — only valid ones returned", () => {
    const mounts: MountRequest[] = [
      { hostPath: join(safeProjects, "my-app") },           // valid
      { hostPath: join(tmpRoot, "nonexistent") },           // invalid — does not exist
      { hostPath: join(safeRepos, "lib") },                 // valid
      { hostPath: join(sensitiveDir, ".ssh") },             // invalid — blocked pattern
    ];

    const validated = validateAdditionalMounts(mounts, makeAllowlist(), true);
    expect(validated).toHaveLength(2);
    expect(validated.map((m) => m.containerPath)).toContain("/workspace/extra/my-app");
    expect(validated.map((m) => m.containerPath)).toContain("/workspace/extra/lib");
  });

  it("31. onRejected callback receives all rejected mounts with reasons", () => {
    const rejected: Array<{ mount: MountRequest; reason: string }> = [];

    const mounts: MountRequest[] = [
      { hostPath: join(safeProjects, "my-app") },           // passes
      { hostPath: join(tmpRoot, "nonexistent") },           // rejected — does not exist
      { hostPath: join(sensitiveDir, ".ssh") },             // rejected — blocked
    ];

    validateAdditionalMounts(mounts, makeAllowlist(), true, (mount, reason) => {
      rejected.push({ mount, reason });
    });

    expect(rejected).toHaveLength(2);
    expect(rejected[0].reason).toContain("does not exist");
    expect(rejected[1].reason).toContain(".ssh");
  });

  it("32. empty input returns empty array", () => {
    const validated = validateAdditionalMounts([], makeAllowlist(), true);
    expect(validated).toHaveLength(0);
  });

  it("33. all rejected returns empty array", () => {
    const mounts: MountRequest[] = [
      { hostPath: join(tmpRoot, "nonexistent-a") },
      { hostPath: join(tmpRoot, "nonexistent-b") },
    ];
    const validated = validateAdditionalMounts(mounts, makeAllowlist(), true);
    expect(validated).toHaveLength(0);
  });

  it("34. container paths are prefixed with /workspace/extra/", () => {
    const mounts: MountRequest[] = [
      { hostPath: join(safeProjects, "my-app"), containerPath: "app" },
      { hostPath: join(safeRepos, "lib"), containerPath: "libs" },
    ];

    const validated = validateAdditionalMounts(mounts, makeAllowlist(), true);
    expect(validated).toHaveLength(2);
    expect(validated[0].containerPath).toBe("/workspace/extra/app");
    expect(validated[1].containerPath).toBe("/workspace/extra/libs");
  });
});
