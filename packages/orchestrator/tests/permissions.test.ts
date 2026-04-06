import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir, homedir } from "node:os";
import { mkdirSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, normalize } from "node:path";
import {
  parseRule,
  toPosixPath,
  expandPattern,
  expandInputPath,
  resolveCanonicalPath,
  matchGlob,
  extractFilePath,
  ruleMatches,
  evaluateAgentPermissions,
  FILE_PATH_FIELDS,
  type AgentPermissionRule,
  type PermissionContext,
} from "../src/permissions.js";

// ── parseRule ──────────────────────────────────────────────────────────────

describe("parseRule", () => {
  it("parses allow:*", () => {
    expect(parseRule("allow:*")).toEqual({ action: "allow", tool: "*" });
  });

  it("parses deny:*", () => {
    expect(parseRule("deny:*")).toEqual({ action: "deny", tool: "*" });
  });

  it("parses allow:ToolName", () => {
    expect(parseRule("allow:Bash")).toEqual({ action: "allow", tool: "Bash" });
  });

  it("parses deny:ToolName", () => {
    expect(parseRule("deny:Write")).toEqual({ action: "deny", tool: "Write" });
  });

  it("parses allow:Tool(pattern)", () => {
    expect(parseRule("allow:Bash(git *)")).toEqual({
      action: "allow",
      tool: "Bash",
      pattern: "git *",
    });
  });

  it("parses deny:Tool(path pattern) with / prefix", () => {
    expect(parseRule("deny:Write(/config/**)")).toEqual({
      action: "deny",
      tool: "Write",
      pattern: "/config/**",
    });
  });

  it("parses deny:Tool(path pattern) with // prefix", () => {
    expect(parseRule("deny:Write(//c/Users/mail/**)")).toEqual({
      action: "deny",
      tool: "Write",
      pattern: "//c/Users/mail/**",
    });
  });

  it("handles pattern with colons", () => {
    expect(parseRule("deny:Bash(ssh user@host:22)")).toEqual({
      action: "deny",
      tool: "Bash",
      pattern: "ssh user@host:22",
    });
  });

  it("throws on missing colon", () => {
    expect(() => parseRule("allowBash")).toThrow("missing ':'");
  });

  it("parses ask:ToolName", () => {
    expect(parseRule("ask:Bash")).toEqual({ action: "ask", tool: "Bash" });
  });

  it("parses ask:Tool(pattern)", () => {
    expect(parseRule("ask:Write(/data/**)")).toEqual({
      action: "ask",
      tool: "Write",
      pattern: "/data/**",
    });
  });

  it("parses ask:*", () => {
    expect(parseRule("ask:*")).toEqual({ action: "ask", tool: "*" });
  });

  it("throws on invalid action", () => {
    expect(() => parseRule("permit:Bash")).toThrow('Invalid action "permit"');
  });

  it("throws on empty selector", () => {
    expect(() => parseRule("allow:")).toThrow("Empty selector");
  });

  it("throws on unclosed parenthesis", () => {
    expect(() => parseRule("deny:Write(foo")).toThrow("Unclosed parenthesis");
  });

  it("throws on empty tool name before parens", () => {
    expect(() => parseRule("deny:(foo)")).toThrow("Empty tool name");
  });

  it("throws on empty pattern in parens", () => {
    expect(() => parseRule("deny:Write()")).toThrow("Empty pattern");
  });
});

// ── toPosixPath ────────────────────────────────────────────────────────────

describe("toPosixPath", () => {
  it("converts Windows drive letters to POSIX form", () => {
    expect(toPosixPath("C:\\Users\\mail\\file.txt")).toBe("/c/Users/mail/file.txt");
    expect(toPosixPath("D:\\projects\\src")).toBe("/d/projects/src");
  });

  it("converts lowercase drive letters", () => {
    expect(toPosixPath("c:\\Users\\mail")).toBe("/c/Users/mail");
  });

  it("replaces all backslashes", () => {
    expect(toPosixPath("foo\\bar\\baz")).toBe("foo/bar/baz");
  });

  it("passes Unix paths unchanged", () => {
    expect(toPosixPath("/home/user/file.txt")).toBe("/home/user/file.txt");
  });

  it("handles empty string", () => {
    expect(toPosixPath("")).toBe("");
  });
});

// ── extractFilePath ────────────────────────────────────────────────────────

describe("extractFilePath", () => {
  it("extracts file_path for Read", () => {
    expect(extractFilePath("Read", { file_path: "/tmp/foo.txt" })).toBe("/tmp/foo.txt");
  });

  it("extracts file_path for Write", () => {
    expect(extractFilePath("Write", { file_path: "/tmp/out.txt", content: "hi" })).toBe("/tmp/out.txt");
  });

  it("extracts file_path for Edit", () => {
    expect(extractFilePath("Edit", { file_path: "/tmp/edit.txt" })).toBe("/tmp/edit.txt");
  });

  it("extracts path for Glob", () => {
    expect(extractFilePath("Glob", { path: "/src", pattern: "*.ts" })).toBe("/src");
  });

  it("extracts path for Grep", () => {
    expect(extractFilePath("Grep", { path: "/src", pattern: "foo" })).toBe("/src");
  });

  it("returns null for Bash", () => {
    expect(extractFilePath("Bash", { command: "ls" })).toBeNull();
  });

  it("returns null for unknown tools", () => {
    expect(extractFilePath("WebSearch", { query: "foo" })).toBeNull();
  });

  it("returns null when field is missing", () => {
    expect(extractFilePath("Read", {})).toBeNull();
  });

  it("returns null when field is empty string", () => {
    expect(extractFilePath("Read", { file_path: "" })).toBeNull();
  });

  it("returns null when field is non-string", () => {
    expect(extractFilePath("Read", { file_path: 123 })).toBeNull();
  });
});

// ── expandPattern ──────────────────────────────────────────────────────────

describe("expandPattern", () => {
  // Use real native paths for the context, then check POSIX output
  const home = resolve("/home/user");
  const agentCwd = resolve("/workspace/agent");
  const platformRoot = resolve("/home/user/.stockade");
  const ctx: PermissionContext = { homeDir: home, agentCwd, platformRoot };

  it("// prefix → absolute POSIX path (strip one /)", () => {
    expect(expandPattern("//c/Users/mail/file.txt", ctx)).toBe("/c/Users/mail/file.txt");
    expect(expandPattern("//home/user/data/**", ctx)).toBe("/home/user/data/**");
  });

  it("~/ prefix → home directory in POSIX form", () => {
    const result = expandPattern("~/Documents/**", ctx);
    expect(result).toBe(toPosixPath(resolve(home, "Documents/**")));
  });

  it("bare ~ → home directory", () => {
    expect(expandPattern("~", ctx)).toBe(toPosixPath(resolve(home)));
  });

  it("/ prefix → platform root in POSIX form", () => {
    const result = expandPattern("/config/**", ctx);
    expect(result).toBe(toPosixPath(resolve(platformRoot, "config/**")));
  });

  it("/ alone → platform root", () => {
    // Unlikely usage but should work
    const result = expandPattern("/", ctx);
    expect(result).toBe(toPosixPath(resolve(platformRoot, "")));
  });

  it("./ prefix → agent cwd in POSIX form", () => {
    const result = expandPattern("./data/**", ctx);
    expect(result).toBe(toPosixPath(resolve(agentCwd, "data/**")));
  });

  it("bare relative → agent cwd in POSIX form", () => {
    const result = expandPattern("notes.md", ctx);
    expect(result).toBe(toPosixPath(resolve(agentCwd, "notes.md")));
  });
});

// ── expandInputPath ────────────────────────────────────────────────────────

describe("expandInputPath", () => {
  const home = resolve("/home/user");
  const agentCwd = resolve("/workspace/agent");
  const platformRoot = resolve("/home/user/.stockade");
  const ctx: PermissionContext = { homeDir: home, agentCwd, platformRoot };

  it("expands ~ to home directory", () => {
    const result = expandInputPath("~/config.yaml", ctx);
    expect(result).toBe(resolve(home, "config.yaml"));
  });

  it("resolves relative paths against agent cwd", () => {
    const result = expandInputPath("foo/bar.txt", ctx);
    expect(result).toBe(resolve(agentCwd, "foo/bar.txt"));
  });

  it("normalizes .. segments", () => {
    const result = expandInputPath(resolve("/workspace/agent/../other/file.txt"), ctx);
    expect(result).toBe(resolve("/workspace/other/file.txt"));
  });

  it("keeps absolute paths as-is (resolved)", () => {
    const result = expandInputPath(resolve("/etc/passwd"), ctx);
    expect(result).toBe(resolve("/etc/passwd"));
  });
});

// ── resolveCanonicalPath ───────────────────────────────────────────────────

describe("resolveCanonicalPath", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `perm-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves an existing file to its real POSIX path", async () => {
    const file = join(tempDir, "real.txt");
    writeFileSync(file, "hello");
    const result = await resolveCanonicalPath(file);
    expect(result).toBe(toPosixPath(normalize(file)));
  });

  it("resolves a non-existent file in an existing directory", async () => {
    const file = join(tempDir, "nonexistent.txt");
    const result = await resolveCanonicalPath(file);
    // Should be POSIX-normalized
    expect(result).toContain("nonexistent.txt");
    expect(result).not.toContain("\\");
  });

  it("resolves a path with .. to canonical POSIX form", async () => {
    const subDir = join(tempDir, "sub");
    mkdirSync(subDir);
    writeFileSync(join(tempDir, "real.txt"), "hello");
    const traversal = join(tempDir, "sub", "..", "real.txt");
    const result = await resolveCanonicalPath(traversal);
    expect(result).toBe(toPosixPath(join(tempDir, "real.txt")));
  });

  it("resolves symlinks to their target", async () => {
    const realFile = join(tempDir, "target.txt");
    writeFileSync(realFile, "secret");
    const linkPath = join(tempDir, "link.txt");
    try {
      symlinkSync(realFile, linkPath);
    } catch {
      return; // Skip if symlinks not available
    }
    const result = await resolveCanonicalPath(linkPath);
    expect(result).toBe(toPosixPath(realFile));
  });

  it("resolves directory symlinks", async () => {
    const realDir = join(tempDir, "realdir");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "data.txt"), "content");
    const linkDir = join(tempDir, "linkdir");
    try {
      symlinkSync(realDir, linkDir, "junction");
    } catch {
      return;
    }
    const result = await resolveCanonicalPath(join(linkDir, "data.txt"));
    expect(result).toBe(toPosixPath(join(realDir, "data.txt")));
  });
});

// ── matchGlob ──────────────────────────────────────────────────────────────

describe("matchGlob", () => {
  it("matches exact strings", () => {
    expect(matchGlob("/etc/passwd", "/etc/passwd")).toBe(true);
  });

  it("rejects non-matching strings", () => {
    expect(matchGlob("/etc/shadow", "/etc/passwd")).toBe(false);
  });

  it("* matches within a single segment", () => {
    expect(matchGlob("/home/user/file.txt", "/home/user/*.txt")).toBe(true);
    expect(matchGlob("/home/user/file.ts", "/home/user/*.txt")).toBe(false);
  });

  it("* does not cross path separators in path mode", () => {
    expect(matchGlob("/home/user/sub/file.txt", "/home/user/*.txt")).toBe(false);
  });

  it("** matches across path separators", () => {
    expect(matchGlob("/home/user/a/b/c/file.txt", "/home/user/**")).toBe(true);
  });

  it("**/ matches zero or more segments", () => {
    expect(matchGlob("/home/user/file.txt", "/home/**/file.txt")).toBe(true);
    expect(matchGlob("/home/user/a/b/file.txt", "/home/**/file.txt")).toBe(true);
  });

  it("? matches single character (not separator)", () => {
    expect(matchGlob("/tmp/a.txt", "/tmp/?.txt")).toBe(true);
    expect(matchGlob("/tmp/ab.txt", "/tmp/?.txt")).toBe(false);
  });

  it("handles backslash normalization", () => {
    expect(matchGlob("C:\\Users\\mail\\file.txt", "C:/Users/mail/*.txt")).toBe(true);
  });

  it("matches Bash commands with * glob (text mode)", () => {
    expect(matchGlob("git status", "git *", false)).toBe(true);
    expect(matchGlob("git log --oneline", "git *", false)).toBe(true);
    expect(matchGlob("rm -rf /", "git *", false)).toBe(false);
  });

  it("* in path mode does NOT cross /", () => {
    expect(matchGlob("rm -rf /home", "rm -rf *")).toBe(false);
    // But in text mode it does
    expect(matchGlob("rm -rf /home", "rm -rf *", false)).toBe(true);
    expect(matchGlob("rm file.txt", "rm -rf *", false)).toBe(false);
  });

  it("escapes regex special chars in pattern", () => {
    expect(matchGlob("file.txt", "file.txt")).toBe(true);
    expect(matchGlob("filextxt", "file.txt")).toBe(false);
  });
});

// ── ruleMatches ────────────────────────────────────────────────────────────

describe("ruleMatches", () => {
  // Use real temp dir for context so paths resolve correctly
  const home = resolve("/home/user");
  const agentCwd = resolve("/workspace/agent");
  const platformRoot = resolve("/home/user/.stockade");
  const ctx: PermissionContext = { homeDir: home, agentCwd, platformRoot };

  it("wildcard rule matches any tool", async () => {
    const rule: AgentPermissionRule = { action: "allow", tool: "*" };
    expect(await ruleMatches(rule, "Bash", { command: "ls" }, ctx)).toBe(true);
    expect(await ruleMatches(rule, "Read", { file_path: resolve("/tmp") }, ctx)).toBe(true);
    expect(await ruleMatches(rule, "WebSearch", { query: "foo" }, ctx)).toBe(true);
  });

  it("tool name rule matches that tool only", async () => {
    const rule: AgentPermissionRule = { action: "deny", tool: "Bash" };
    expect(await ruleMatches(rule, "Bash", { command: "ls" }, ctx)).toBe(true);
    expect(await ruleMatches(rule, "Read", { file_path: resolve("/tmp") }, ctx)).toBe(false);
  });

  it("file tool with / pattern matches against platform root", async () => {
    const rule: AgentPermissionRule = {
      action: "deny",
      tool: "Write",
      pattern: "/config/**",
    };
    // Path inside platform root config dir
    const configFile = join(platformRoot, "config", "agents.yaml");
    expect(
      await ruleMatches(rule, "Write", { file_path: configFile }, ctx),
    ).toBe(true);
    // Path outside platform root config dir
    const otherFile = join(platformRoot, "agents", "main", "file.txt");
    expect(
      await ruleMatches(rule, "Write", { file_path: otherFile }, ctx),
    ).toBe(false);
  });

  it("file tool pattern with ~ expands home directory", async () => {
    const rule: AgentPermissionRule = {
      action: "deny",
      tool: "Edit",
      pattern: "~/secret/**",
    };
    expect(
      await ruleMatches(
        rule,
        "Edit",
        { file_path: join(home, "secret", "key.pem") },
        ctx,
      ),
    ).toBe(true);
    expect(
      await ruleMatches(
        rule,
        "Edit",
        { file_path: join(home, "other", "file.txt") },
        ctx,
      ),
    ).toBe(false);
  });

  it("file tool with // pattern matches absolute POSIX path", async () => {
    const posixTmp = toPosixPath(resolve("/tmp"));
    const rule: AgentPermissionRule = {
      action: "deny",
      tool: "Read",
      pattern: `//${posixTmp.slice(1)}/**`,
    };
    expect(
      await ruleMatches(rule, "Read", { file_path: resolve("/tmp/secret.txt") }, ctx),
    ).toBe(true);
  });

  it("Bash rule with command pattern matches commands", async () => {
    const rule: AgentPermissionRule = {
      action: "allow",
      tool: "Bash",
      pattern: "git *",
    };
    expect(await ruleMatches(rule, "Bash", { command: "git status" }, ctx)).toBe(true);
    expect(await ruleMatches(rule, "Bash", { command: "rm -rf /" }, ctx)).toBe(false);
  });

  it("pattern on non-file non-Bash tool returns false", async () => {
    const rule: AgentPermissionRule = {
      action: "deny",
      tool: "WebSearch",
      pattern: "secret query",
    };
    expect(
      await ruleMatches(rule, "WebSearch", { query: "secret query" }, ctx),
    ).toBe(false);
  });

  it("tool mismatch returns false regardless of pattern", async () => {
    const rule: AgentPermissionRule = {
      action: "deny",
      tool: "Write",
      pattern: "/config/**",
    };
    const configFile = join(platformRoot, "config", "a.yaml");
    expect(
      await ruleMatches(rule, "Read", { file_path: configFile }, ctx),
    ).toBe(false);
  });

  it("file tool without path in input: rule with pattern does not match", async () => {
    const rule: AgentPermissionRule = {
      action: "deny",
      tool: "Read",
      pattern: "/agents/secret/**",
    };
    expect(await ruleMatches(rule, "Read", {}, ctx)).toBe(false);
  });
});

// ── evaluateAgentPermissions ───────────────────────────────────────────────

describe("evaluateAgentPermissions", () => {
  const home = resolve("/home/user");
  const agentCwd = resolve("/workspace/agent");
  const platformRoot = resolve("/home/user/.stockade");
  const ctx: PermissionContext = { homeDir: home, agentCwd, platformRoot };

  it("undefined rules → allow (backwards-compatible)", async () => {
    expect(await evaluateAgentPermissions(undefined, "Bash", { command: "rm -rf /" }, ctx)).toBe(
      "allow",
    );
  });

  it("empty rules → ask (no rules match = HITL approval)", async () => {
    expect(await evaluateAgentPermissions([], "Read", { file_path: resolve("/tmp") }, ctx)).toBe("ask");
  });

  it("allow:* permits everything", async () => {
    const rules = ["allow:*"];
    expect(await evaluateAgentPermissions(rules, "Bash", { command: "rm -rf /" }, ctx)).toBe(
      "allow",
    );
    expect(await evaluateAgentPermissions(rules, "Write", { file_path: resolve("/etc/passwd") }, ctx)).toBe(
      "allow",
    );
  });

  it("deny:* blocks everything", async () => {
    const rules = ["deny:*"];
    expect(await evaluateAgentPermissions(rules, "Read", { file_path: resolve("/tmp") }, ctx)).toBe("deny");
    expect(await evaluateAgentPermissions(rules, "Bash", { command: "ls" }, ctx)).toBe("deny");
  });

  it("first match wins — deny before allow", async () => {
    const rules = [
      "deny:Write(/config/**)",
      "allow:*",
    ];
    expect(
      await evaluateAgentPermissions(
        rules, "Write",
        { file_path: join(platformRoot, "config", "agents.yaml") },
        ctx,
      ),
    ).toBe("deny");
    expect(
      await evaluateAgentPermissions(
        rules, "Write",
        { file_path: resolve("/data/output.txt") },
        ctx,
      ),
    ).toBe("allow");
  });

  it("first match wins — allow before deny", async () => {
    const rules = [
      "allow:Bash(git *)",
      "deny:Bash",
      "allow:*",
    ];
    expect(await evaluateAgentPermissions(rules, "Bash", { command: "git status" }, ctx)).toBe(
      "allow",
    );
    expect(await evaluateAgentPermissions(rules, "Bash", { command: "rm -rf /" }, ctx)).toBe(
      "deny",
    );
    expect(await evaluateAgentPermissions(rules, "Read", { file_path: resolve("/tmp") }, ctx)).toBe(
      "allow",
    );
  });

  it("/ prefix protects config directory (platform-root-relative)", async () => {
    const rules = [
      "deny:Write(/config/**)",
      "deny:Edit(/config/**)",
      "allow:*",
    ];
    // Denied — inside platform root config
    expect(
      await evaluateAgentPermissions(
        rules, "Write",
        { file_path: join(platformRoot, "config", "agents.yaml") },
        ctx,
      ),
    ).toBe("deny");
    expect(
      await evaluateAgentPermissions(
        rules, "Edit",
        { file_path: join(platformRoot, "config", "platform.yaml") },
        ctx,
      ),
    ).toBe("deny");
    // Allowed — Read is fine
    expect(
      await evaluateAgentPermissions(
        rules, "Read",
        { file_path: join(platformRoot, "config", "agents.yaml") },
        ctx,
      ),
    ).toBe("allow");
    // Allowed — different directory under platform root
    expect(
      await evaluateAgentPermissions(
        rules, "Write",
        { file_path: join(platformRoot, "agents", "main", "data.txt") },
        ctx,
      ),
    ).toBe("allow");
  });

  it("/ prefix protects other agents' workspaces", async () => {
    const rules = [
      "deny:Write(/agents/explorer/**)",
      "deny:Edit(/agents/explorer/**)",
      "allow:*",
    ];
    expect(
      await evaluateAgentPermissions(
        rules, "Write",
        { file_path: join(platformRoot, "agents", "explorer", "data.txt") },
        ctx,
      ),
    ).toBe("deny");
    expect(
      await evaluateAgentPermissions(
        rules, "Write",
        { file_path: join(platformRoot, "agents", "main", "data.txt") },
        ctx,
      ),
    ).toBe("allow");
  });

  it("no matching rule → implicit ask", async () => {
    const rules = [
      "allow:Read",
      "allow:Glob",
      "allow:Grep",
    ];
    expect(await evaluateAgentPermissions(rules, "Read", { file_path: resolve("/tmp") }, ctx)).toBe(
      "allow",
    );
    expect(await evaluateAgentPermissions(rules, "Write", { file_path: resolve("/tmp") }, ctx)).toBe(
      "ask",
    );
    expect(await evaluateAgentPermissions(rules, "Bash", { command: "ls" }, ctx)).toBe("ask");
  });

  it("explicit ask rule returns ask", async () => {
    const rules = [
      "allow:Read",
      "ask:Write",
      "deny:Bash",
      "allow:*",
    ];
    expect(await evaluateAgentPermissions(rules, "Read", { file_path: resolve("/tmp") }, ctx)).toBe("allow");
    expect(await evaluateAgentPermissions(rules, "Write", { file_path: resolve("/tmp") }, ctx)).toBe("ask");
    expect(await evaluateAgentPermissions(rules, "Bash", { command: "ls" }, ctx)).toBe("deny");
    expect(await evaluateAgentPermissions(rules, "Glob", { pattern: "*.ts" }, ctx)).toBe("allow");
  });

  it("ask:* requires approval for everything", async () => {
    const rules = ["ask:*"];
    expect(await evaluateAgentPermissions(rules, "Read", { file_path: resolve("/tmp") }, ctx)).toBe("ask");
    expect(await evaluateAgentPermissions(rules, "Bash", { command: "ls" }, ctx)).toBe("ask");
  });

  it("ask with path pattern", async () => {
    const rules = [
      "ask:Write(/sensitive/**)",
      "allow:*",
    ];
    expect(
      await evaluateAgentPermissions(
        rules, "Write",
        { file_path: join(platformRoot, "sensitive", "data.txt") },
        ctx,
      ),
    ).toBe("ask");
    expect(
      await evaluateAgentPermissions(
        rules, "Write",
        { file_path: resolve("/other/file.txt") },
        ctx,
      ),
    ).toBe("allow");
  });

  it("MCP-style tool names work", async () => {
    const rules = [
      "allow:mcp__agent__start",
      "allow:*",
    ];
    expect(
      await evaluateAgentPermissions(
        rules,
        "mcp__agent__start",
        { agentId: "explorer", task: "look up X" },
        ctx,
      ),
    ).toBe("allow");
  });

  it("handles path traversal in input (.. normalization)", async () => {
    const rules = [
      "deny:Write(/config/**)",
      "allow:*",
    ];
    // Traversal: ~/.stockade/agents/../config/secret.txt → ~/.stockade/config/secret.txt
    expect(
      await evaluateAgentPermissions(
        rules, "Write",
        { file_path: join(platformRoot, "agents", "..", "config", "secret.txt") },
        ctx,
      ),
    ).toBe("deny");
  });

  it("relative paths in input resolve against agent cwd", async () => {
    const agentConfigDir = toPosixPath(resolve(agentCwd, "config"));
    const rules = [
      `deny:Write(//${agentConfigDir.slice(1)}/**)`,
      "allow:*",
    ];
    // Relative path "config/secret.yaml" resolves to agentCwd/config/secret.yaml
    expect(
      await evaluateAgentPermissions(
        rules, "Write",
        { file_path: "config/secret.yaml" },
        ctx,
      ),
    ).toBe("deny");
    expect(
      await evaluateAgentPermissions(
        rules, "Write",
        { file_path: "data/output.txt" },
        ctx,
      ),
    ).toBe("allow");
  });
});

// ── Realistic agent config scenarios ───────────────────────────────────────

describe("realistic agent permission scenarios", () => {
  const home = resolve("/home/shitiz");
  const platformRoot = join(home, ".stockade");
  const ctx: PermissionContext = {
    homeDir: home,
    agentCwd: join(platformRoot, "agents", "main"),
    platformRoot,
  };

  // Clean rules using / prefix (platform-root-relative)
  const mainAgentRules = [
    // Protect platform config
    "deny:Write(/config/**)",
    "deny:Edit(/config/**)",
    // Protect other agents' workspaces
    "deny:Write(/agents/explorer/**)",
    "deny:Edit(/agents/explorer/**)",
    "deny:Write(/agents/operator/**)",
    "deny:Edit(/agents/operator/**)",
    "deny:Write(/agents/engineer/**)",
    "deny:Edit(/agents/engineer/**)",
    // Allow everything else
    "allow:*",
  ];

  it("main agent can write to its own workspace", async () => {
    expect(
      await evaluateAgentPermissions(
        mainAgentRules, "Write",
        { file_path: join(platformRoot, "agents", "main", "notes.md") },
        ctx,
      ),
    ).toBe("allow");
  });

  it("main agent cannot write to config", async () => {
    expect(
      await evaluateAgentPermissions(
        mainAgentRules, "Write",
        { file_path: join(platformRoot, "config", "config.yaml") },
        ctx,
      ),
    ).toBe("deny");
  });

  it("main agent cannot edit explorer's workspace", async () => {
    expect(
      await evaluateAgentPermissions(
        mainAgentRules, "Edit",
        { file_path: join(platformRoot, "agents", "explorer", "CLAUDE.md") },
        ctx,
      ),
    ).toBe("deny");
  });

  it("main agent can read config (read-only access)", async () => {
    expect(
      await evaluateAgentPermissions(
        mainAgentRules, "Read",
        { file_path: join(platformRoot, "config", "config.yaml") },
        ctx,
      ),
    ).toBe("allow");
  });

  it("main agent can use Bash freely", async () => {
    expect(
      await evaluateAgentPermissions(mainAgentRules, "Bash", { command: "git status" }, ctx),
    ).toBe("allow");
  });

  // Read-only researcher agent
  const researcherRules = [
    "allow:Read",
    "allow:WebSearch",
    "allow:WebFetch",
    "allow:Bash(curl *)",
    "allow:Bash(git log *)",
  ];

  it("researcher can read files", async () => {
    expect(
      await evaluateAgentPermissions(
        researcherRules, "Read",
        { file_path: resolve("/tmp/data.txt") },
        ctx,
      ),
    ).toBe("allow");
  });

  it("researcher can search the web", async () => {
    expect(
      await evaluateAgentPermissions(researcherRules, "WebSearch", { query: "foo" }, ctx),
    ).toBe("allow");
  });

  it("researcher write falls through to ask (no matching rule)", async () => {
    expect(
      await evaluateAgentPermissions(
        researcherRules, "Write",
        { file_path: resolve("/tmp/out.txt") },
        ctx,
      ),
    ).toBe("ask");
  });

  it("researcher can run curl, rm falls through to ask", async () => {
    expect(
      await evaluateAgentPermissions(
        researcherRules, "Bash",
        { command: "curl https://example.com" },
        ctx,
      ),
    ).toBe("allow");
    expect(
      await evaluateAgentPermissions(researcherRules, "Bash", { command: "rm -rf /" }, ctx),
    ).toBe("ask");
  });
});
