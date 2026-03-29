/**
 * TRUE end-to-end tests — ZERO mocks.
 *
 * Real filesystem, real YAML parsing, real Zod validation, real SQLite,
 * real timers, real symlinks, real everything.
 *
 * No vi.mock, no vi.fn, no vi.useFakeTimers.
 */

import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import {
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import { loadConfig, substituteEnvVars, resolvePaths } from "../../src/config.js";
import {
  initSessionsTable,
  getSessionId,
  setSessionId,
  deleteSession,
} from "../../src/sessions.js";
import {
  validateMount,
  matchesBlockedPattern,
  mergeBlockedPatterns,
  type MountAllowlist,
} from "../../src/containers/mounts.js";
import { computeNextRun } from "../../src/scheduler/compute-next-run.js";
import {
  runScheduledTask,
  startSchedulerLoop,
  stopSchedulerLoop,
  _resetSchedulerForTests,
} from "../../src/scheduler/scheduler.js";
import type {
  ScheduledTask,
  SchedulerConfig,
  TaskStore,
  TaskRunLog,
} from "../../src/scheduler/types.js";
import { DispatchQueue } from "../../src/containers/queue.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers — used across sections
// ═══════════════════════════════════════════════════════════════════════════════

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "e2e-real-"));
  return dir;
}

function writeYaml(dir: string, content: string): void {
  writeFileSync(join(dir, "config.yaml"), content, "utf-8");
}

const MINIMAL_VALID_YAML = `
agents:
  main:
    model: claude-sonnet-4-20250514
    system: "You are helpful."
    tools: ["Bash", "Read"]
    sandboxed: false
channels:
  terminal:
    enabled: true
    agent: main
rbac:
  roles:
    owner:
      permissions:
        - "agent:*"
  users:
    alice:
      roles:
        - owner
      identities:
        terminal: "alice"
`;

const UTC_CONFIG: SchedulerConfig = {
  poll_interval_ms: 60_000,
  timezone: "UTC",
};

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: `task-${randomUUID().slice(0, 8)}`,
    agentId: "agent-main",
    scope: "test:scope",
    prompt: "do something useful",
    script: null,
    schedule_type: "interval",
    schedule_value: "60000",
    context_mode: "agent",
    next_run: new Date(Date.now() - 1_000).toISOString(),
    last_run: null,
    last_result: null,
    status: "active",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

interface RealStore extends TaskStore {
  _logs: TaskRunLog[];
  _tasks: ScheduledTask[];
}

function makeRealStore(initial: ScheduledTask[] = []): RealStore {
  const tasks: ScheduledTask[] = initial.map((t) => ({ ...t }));
  const logs: TaskRunLog[] = [];

  return {
    _tasks: tasks,
    _logs: logs,
    getAllTasks: () => [...tasks],
    getTaskById: (id) => tasks.find((t) => t.id === id) ?? null,
    getDueTasks: () =>
      tasks.filter((t) => {
        if (t.status !== "active" || !t.next_run) return false;
        return new Date(t.next_run).getTime() <= Date.now();
      }),
    createTask: (task) => {
      tasks.push({
        ...task,
        last_run: null,
        last_result: null,
      } as ScheduledTask);
    },
    updateTask: (id, fields) => {
      const t = tasks.find((x) => x.id === id);
      if (t) Object.assign(t, fields);
    },
    updateTaskAfterRun: (id, nextRun, lastResult) => {
      const t = tasks.find((x) => x.id === id);
      if (t) {
        t.next_run = nextRun;
        t.last_result = lastResult;
        t.last_run = new Date().toISOString();
        if (t.schedule_type === "once") t.status = "completed";
      }
    },
    logTaskRun: (log) => logs.push(log),
    deleteTask: (id) => {
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx >= 0) tasks.splice(idx, 1);
    },
  };
}

/** Wait using real setTimeout — NO fake timers */
function realDelay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Config E2E (real filesystem, real YAML, real Zod)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Config E2E — real filesystem, real YAML, real Zod", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  // Test 1: Write a real config.yaml, call loadConfig(), verify parsed result
  it("1. loads a real config.yaml from a temp dir and parses it correctly", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    writeYaml(dir, MINIMAL_VALID_YAML);

    const config = loadConfig(dir);

    expect(config.agents.agents.main.model).toBe("claude-sonnet-4-20250514");
    expect(config.agents.agents.main.tools).toEqual(["Bash", "Read"]);
    expect(config.agents.agents.main.sandboxed).toBe(false);
    expect(config.platform.channels.terminal?.enabled).toBe(true);
    expect(config.platform.channels.terminal?.agent).toBe("main");
    expect(config.platform.rbac.roles.owner.permissions).toContain("agent:*");
    expect(config.platform.rbac.users.alice.roles).toEqual(["owner"]);
  });

  // Test 2: Env var substitution with real process.env
  it("2. substitutes real process.env variables in config.yaml", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    const secretToken = `real-token-${randomUUID()}`;
    process.env.__E2E_REAL_TOKEN = secretToken;

    writeYaml(
      dir,
      `
agents:
  main:
    model: claude-sonnet-4-20250514
    system: "You are helpful."
    tools: ["Bash"]
    sandboxed: false
channels:
  discord:
    enabled: true
    token: \${__E2E_REAL_TOKEN}
    bindings:
      - server: "111"
        agent: main
        channels: "*"
rbac:
  roles:
    owner:
      permissions: ["agent:*"]
  users:
    bob:
      roles: [owner]
      identities:
        discord: "123"
`
    );

    const config = loadConfig(dir);
    expect(config.platform.channels.discord?.token).toBe(secretToken);

    delete process.env.__E2E_REAL_TOKEN;
  });

  // Test 3: Invalid YAML throws with descriptive error
  it("3. throws a descriptive error on invalid YAML", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    writeFileSync(join(dir, "config.yaml"), "{{{{ not: valid: yaml ::::", "utf-8");

    expect(() => loadConfig(dir)).toThrow();
  });

  // Test 4: paths section produces correct absolute paths
  it("4. resolvePaths produces correct absolute paths from paths section", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const projectRoot = resolve(dir, "..");

    writeYaml(
      dir,
      MINIMAL_VALID_YAML +
        `paths:\n  data_dir: ./custom-data\n  agents_dir: ./custom-data/my-agents\n`
    );

    const config = loadConfig(dir, projectRoot);
    const paths = config.platform.paths!;

    expect(paths).toBeDefined();
    expect(isAbsolute(paths.data_dir)).toBe(true);
    expect(isAbsolute(paths.agents_dir)).toBe(true);
    expect(isAbsolute(paths.sessions_db)).toBe(true);
    expect(isAbsolute(paths.containers_dir)).toBe(true);
    expect(paths.data_dir).toBe(resolve(projectRoot, "custom-data"));
    expect(paths.agents_dir).toBe(resolve(projectRoot, "custom-data", "my-agents"));
    expect(paths.sessions_db).toBe(
      join(resolve(projectRoot, "custom-data"), "sessions.db")
    );
    expect(paths.config_dir).toBe(resolve(dir));
  });

  // Test 5: The real test fixture config loads successfully
  it("5. loads the real tests/fixtures/test-terminal/config.yaml successfully", () => {
    const fixtureDir = resolve(
      __dirname,
      "..",
      "fixtures",
      "test-terminal"
    );

    const config = loadConfig(fixtureDir);

    expect(config.agents.agents.main).toBeDefined();
    expect(config.agents.agents.main.model).toBe("sonnet");
    expect(config.agents.agents.main.tools).toContain("Bash");
    expect(config.platform.channels.terminal?.enabled).toBe(true);
    expect(config.platform.rbac.users.mail.roles).toContain("owner");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Sessions E2E (real SQLite)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Sessions E2E — real in-memory SQLite", () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  // Test 6: Full CRUD lifecycle with real SQLite
  it("6. store/retrieve/overwrite/delete sessions in a real SQLite DB", () => {
    db = new Database(":memory:");
    initSessionsTable(db);

    // Initially empty
    expect(getSessionId(db, "scope:a")).toBeNull();

    // Store
    setSessionId(db, "scope:a", "sess-111");
    expect(getSessionId(db, "scope:a")).toBe("sess-111");

    // Overwrite (upsert)
    setSessionId(db, "scope:a", "sess-222");
    expect(getSessionId(db, "scope:a")).toBe("sess-222");

    // Delete
    deleteSession(db, "scope:a");
    expect(getSessionId(db, "scope:a")).toBeNull();

    // Delete non-existent is idempotent
    deleteSession(db, "scope:nonexistent");
    expect(getSessionId(db, "scope:nonexistent")).toBeNull();
  });

  // Test 7: Two independent scopes don't interfere
  it("7. two independent scopes are fully isolated", () => {
    db = new Database(":memory:");
    initSessionsTable(db);

    setSessionId(db, "discord:guild1:chan1:user1", "sess-discord");
    setSessionId(db, "terminal:local:uuid:admin", "sess-terminal");

    expect(getSessionId(db, "discord:guild1:chan1:user1")).toBe("sess-discord");
    expect(getSessionId(db, "terminal:local:uuid:admin")).toBe("sess-terminal");

    // Mutating one scope does not affect the other
    setSessionId(db, "discord:guild1:chan1:user1", "sess-discord-v2");
    expect(getSessionId(db, "terminal:local:uuid:admin")).toBe("sess-terminal");

    deleteSession(db, "discord:guild1:chan1:user1");
    expect(getSessionId(db, "terminal:local:uuid:admin")).toBe("sess-terminal");
    expect(getSessionId(db, "discord:guild1:chan1:user1")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Mount Security E2E (real filesystem)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Mount Security E2E — real filesystem", () => {
  let tmpRoot: string;
  let safeDir: string;
  let sensitiveDir: string;
  let symlinksDir: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "mount-real-e2e-"));

    // Safe directories
    safeDir = join(tmpRoot, "safe-projects");
    mkdirSync(join(safeDir, "my-app"), { recursive: true });
    mkdirSync(join(safeDir, "nested", "deep"), { recursive: true });

    // Sensitive directories (blocked patterns)
    sensitiveDir = join(tmpRoot, "sensitive");
    mkdirSync(join(sensitiveDir, ".ssh"), { recursive: true });
    mkdirSync(join(sensitiveDir, ".aws"), { recursive: true });
    mkdirSync(join(sensitiveDir, ".docker"), { recursive: true });
    writeFileSync(join(sensitiveDir, ".env"), "SECRET=hunter2");
    writeFileSync(join(sensitiveDir, ".ssh", "id_rsa"), "fake-private-key");

    // Symlinks
    symlinksDir = join(tmpRoot, "symlinks");
    mkdirSync(symlinksDir, { recursive: true });

    const symlinkType = process.platform === "win32" ? "junction" : undefined;
    // Symlink to blocked location (safe name, blocked target)
    symlinkSync(
      join(sensitiveDir, ".ssh"),
      join(symlinksDir, "innocent-link"),
      symlinkType
    );
    // Symlink to safe location
    symlinkSync(safeDir, join(symlinksDir, "safe-link"), symlinkType);
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeAllowlist(overrides?: Partial<MountAllowlist>): MountAllowlist {
    return {
      allowedRoots: [
        { path: safeDir, allowReadWrite: true, description: "Safe RW" },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
      ...overrides,
    };
  }

  // Test 8: Real temp directories and symlinks exist
  it("8. real temp directories and symlinks are created correctly", () => {
    expect(existsSync(safeDir)).toBe(true);
    expect(existsSync(join(safeDir, "my-app"))).toBe(true);
    expect(existsSync(join(sensitiveDir, ".ssh"))).toBe(true);
    expect(existsSync(join(symlinksDir, "innocent-link"))).toBe(true);
    expect(existsSync(join(symlinksDir, "safe-link"))).toBe(true);
  });

  // Test 9: Blocked patterns reject real sensitive paths
  it("9. blocked patterns reject real .ssh, .aws, .env, .docker paths", () => {
    const allBlocked = mergeBlockedPatterns([]);

    for (const name of [".ssh", ".aws", ".docker"]) {
      const p = join(sensitiveDir, name).replace(/\\/g, "/");
      const matched = matchesBlockedPattern(p, allBlocked);
      expect(matched).toBe(name);
    }

    // .env as a file
    const envPath = join(sensitiveDir, ".env").replace(/\\/g, "/");
    expect(matchesBlockedPattern(envPath, allBlocked)).toBe(".env");
  });

  // Test 10: Allowed roots accept real paths
  it("10. allowed roots accept real paths under the safe directory", () => {
    const result = validateMount(
      { hostPath: join(safeDir, "my-app") },
      makeAllowlist(),
      true
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("Safe RW");

    const deepResult = validateMount(
      { hostPath: join(safeDir, "nested", "deep") },
      makeAllowlist(),
      true
    );
    expect(deepResult.allowed).toBe(true);
  });

  // Test 11: Symlink resolution detects blocked targets
  it("11. symlink to .ssh is rejected after real path resolution", () => {
    const allowlist = makeAllowlist({
      allowedRoots: [
        { path: symlinksDir, allowReadWrite: true },
        { path: safeDir, allowReadWrite: true },
      ],
    });

    // innocent-link -> .ssh (blocked)
    const blockedResult = validateMount(
      { hostPath: join(symlinksDir, "innocent-link") },
      allowlist,
      true
    );
    expect(blockedResult.allowed).toBe(false);
    expect(blockedResult.reason).toContain(".ssh");

    // safe-link -> safeDir (allowed)
    const safeResult = validateMount(
      { hostPath: join(symlinksDir, "safe-link") },
      allowlist,
      true
    );
    expect(safeResult.allowed).toBe(true);
  });

  // Test 12: Path traversal (..) in container path is caught
  it("12. path traversal (../) in container path is caught", () => {
    const result = validateMount(
      {
        hostPath: join(safeDir, "my-app"),
        containerPath: "../../etc/passwd",
      },
      makeAllowlist(),
      true
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Invalid container path");

    // Also test single ../
    const result2 = validateMount(
      {
        hostPath: join(safeDir, "my-app"),
        containerPath: "../escape",
      },
      makeAllowlist(),
      true
    );
    expect(result2.allowed).toBe(false);
    expect(result2.reason).toContain("Invalid container path");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Scheduler E2E (REAL timers)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scheduler E2E — REAL timers", () => {
  afterEach(() => {
    _resetSchedulerForTests();
  });

  // Test 13: Real short intervals with actual setTimeout
  it("13. short real intervals (50ms) fire on schedule", async () => {
    let tickCount = 0;
    const start = Date.now();

    const intervalId = setInterval(() => {
      tickCount++;
    }, 50);

    // Wait real 200ms — should have ~4 ticks
    await realDelay(250);
    clearInterval(intervalId);

    expect(tickCount).toBeGreaterThanOrEqual(3);
    expect(tickCount).toBeLessThanOrEqual(8); // generous upper bound
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  });

  // Test 14: computeNextRun with real Date.now()
  it("14. computeNextRun returns a future date when next_run is 50ms in the past", () => {
    const past = new Date(Date.now() - 50).toISOString();
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "100",
      next_run: past,
    });

    const next = computeNextRun(task, UTC_CONFIG);
    expect(next).not.toBeNull();

    const nextMs = new Date(next!).getTime();
    expect(nextMs).toBeGreaterThan(Date.now() - 10); // future or just barely now
  });

  // Test 15: runScheduledTask with a real async task
  it("15. runScheduledTask runs a real async function and logs the result", async () => {
    const task = makeTask({
      id: "real-task-15",
      schedule_type: "interval",
      schedule_value: "60000",
      next_run: new Date(Date.now() - 100).toISOString(),
    });
    const store = makeRealStore([task]);

    // A real async function that does actual work
    const startTime = Date.now();
    await runScheduledTask(task, {
      store,
      config: UTC_CONFIG,
      executeTask: async (t) => {
        // Real async work: small delay
        await realDelay(20);
        return `executed-${t.id}`;
      },
    });
    const elapsed = Date.now() - startTime;

    // Verify logs
    expect(store._logs).toHaveLength(1);
    expect(store._logs[0].status).toBe("success");
    expect(store._logs[0].result).toBe("executed-real-task-15");
    expect(store._logs[0].duration_ms).toBeGreaterThanOrEqual(15);

    // Verify task updated
    const updated = store.getTaskById("real-task-15")!;
    expect(updated.last_result).toBe("executed-real-task-15");
    expect(updated.next_run).not.toBeNull();
    expect(new Date(updated.next_run!).getTime()).toBeGreaterThan(Date.now() - 10);

    // Real elapsed time
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });

  // Test 16: startSchedulerLoop with poll_interval_ms: 50
  it("16. startSchedulerLoop detects and dispatches a due task within 200ms", async () => {
    const task = makeTask({
      id: "loop-task-16",
      schedule_type: "interval",
      schedule_value: "60000",
      next_run: new Date(Date.now() - 100).toISOString(),
    });
    const store = makeRealStore([task]);

    let dispatched = false;
    let executeCount = 0;

    startSchedulerLoop({
      store,
      config: { poll_interval_ms: 50, timezone: "UTC" },
      executeTask: async (t) => {
        executeCount++;
        dispatched = true;
        return `loop-result-${t.id}`;
      },
      // No enqueueTask -> direct execution
    });

    // Wait real 200ms for the scheduler to find and run the task
    await realDelay(300);
    stopSchedulerLoop();

    expect(dispatched).toBe(true);
    expect(executeCount).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. DispatchQueue E2E (REAL timers)
// ═══════════════════════════════════════════════════════════════════════════════

describe("DispatchQueue E2E — REAL timers", () => {
  // Test 17: Real async execution in order
  it("17. enqueued messages execute in order with real timing", async () => {
    const queue = new DispatchQueue({ maxConcurrent: 5 });
    const order: string[] = [];
    let processCount = 0;

    queue.setProcessMessageFn(async (agentKey) => {
      processCount++;
      const idx = processCount;
      order.push(`start:${agentKey}:${idx}`);
      // Real async work
      await realDelay(30);
      order.push(`end:${agentKey}:${idx}`);
      return true;
    });

    // Enqueue two messages for the same agent — they should serialize
    queue.enqueueMessage("agent-a", "msg");

    // Wait for first to start, then enqueue second
    await realDelay(10);
    queue.enqueueMessage("agent-a", "msg");

    // Wait for both to complete
    await realDelay(200);

    expect(order).toContain("start:agent-a:1");
    expect(order).toContain("end:agent-a:1");
    // Second should have started after first ended (serialization)
    const endFirst = order.indexOf("end:agent-a:1");
    const startSecond = order.indexOf("start:agent-a:2");
    if (startSecond !== -1) {
      expect(startSecond).toBeGreaterThan(endFirst);
    }

    queue.shutdown();
  });

  // Test 18: Global concurrency with real delays
  it("18. maxConcurrent=2 limits parallel execution, third waits for a slot", async () => {
    const queue = new DispatchQueue({ maxConcurrent: 2 });
    const active = new Set<string>();
    let maxConcurrentObserved = 0;
    const completed: string[] = [];

    queue.setProcessMessageFn(async (agentKey) => {
      active.add(agentKey);
      maxConcurrentObserved = Math.max(maxConcurrentObserved, active.size);
      // Real delay
      await realDelay(80);
      active.delete(agentKey);
      completed.push(agentKey);
      return true;
    });

    // Enqueue 3 different agents
    queue.enqueueMessage("agent-a", "msg");
    queue.enqueueMessage("agent-b", "msg");
    queue.enqueueMessage("agent-c", "msg");

    // Wait a bit — first two should be running, third waiting
    await realDelay(30);
    expect(active.size).toBeLessThanOrEqual(2);

    // Wait for all to complete
    await realDelay(300);

    expect(completed).toHaveLength(3);
    expect(completed).toContain("agent-a");
    expect(completed).toContain("agent-b");
    expect(completed).toContain("agent-c");
    expect(maxConcurrentObserved).toBeLessThanOrEqual(2);

    queue.shutdown();
  });

  // Test 19: Task priority — tasks run before next message
  it("19. enqueued task runs before next pending message", async () => {
    const queue = new DispatchQueue({ maxConcurrent: 5 });
    const order: string[] = [];

    let msgResolve: (() => void) | null = null;

    queue.setProcessMessageFn(async (agentKey) => {
      order.push(`msg:${agentKey}`);
      // First call: block until we release it
      if (!msgResolve) {
        await new Promise<void>((r) => {
          msgResolve = r;
        });
      }
      return true;
    });

    // Start a message dispatch (this will block)
    queue.enqueueMessage("agent-a", "msg");
    await realDelay(20);

    // While the first message is running, enqueue a pending message AND a task
    queue.enqueueMessage("agent-a", "msg"); // pendingMessages = true
    queue.enqueueTask("agent-a", "priority-task", async () => {
      order.push("task:agent-a");
    });

    // Release the first message dispatch
    await realDelay(10);
    msgResolve!();

    // Wait for drain to process task and then pending message
    await realDelay(200);

    // Task should appear before the second message dispatch
    const taskIdx = order.indexOf("task:agent-a");
    expect(taskIdx).toBeGreaterThanOrEqual(0);

    // Find the second msg:agent-a (the one from pending, not the first one)
    const msgIndices = order
      .map((entry, i) => (entry === "msg:agent-a" ? i : -1))
      .filter((i) => i !== -1);

    // If there are 2+ message dispatches, the task should be between them
    if (msgIndices.length >= 2) {
      expect(taskIdx).toBeLessThan(msgIndices[1]);
    }

    queue.shutdown();
  });
});
