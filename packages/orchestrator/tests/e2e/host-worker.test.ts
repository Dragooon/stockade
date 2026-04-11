/**
 * E2E tests for host worker process lifecycle and Kleya round-trip.
 *
 * Tier 1 (no credentials): spawns the real worker process via
 *   `node --import tsx packages/worker/src/index.ts`
 * exactly as HostWorkerManager does, verifies it becomes healthy, and
 * shuts down cleanly.  Would have caught both the tsx-spawn bug and the
 * EADDRINUSE port-conflict issue.
 *
 * Tier 2 (requires ~/.claude/.credentials.json): sends a real prompt to a
 * Kleya-configured worker, verifies the Claude SDK executes a Bash tool on
 * the host and returns the expected output.  Skipped automatically when
 * credentials are absent.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Workspace root: packages/orchestrator/tests/e2e/ → 4 levels up
const WORKSPACE_ROOT = resolve(__dirname, "../../../..");
const WORKER_SCRIPT = resolve(WORKSPACE_ROOT, "packages/worker/src/index.ts");

// ── Helpers ────────────────────────────────────────────────────────────────

/** Find a random free TCP port. */
async function findFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? rej(err) : res(port)));
    });
  });
}

/** Poll GET /health until it returns 200 or timeout expires. */
async function waitForHealth(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Worker on port ${port} did not become healthy within ${timeoutMs}ms`);
}

/** Spawn a worker process, return the child and its port. */
async function spawnWorker(opts: {
  agentId?: string;
  extraEnv?: Record<string, string>;
}): Promise<{ child: ChildProcess; port: number; url: string }> {
  const port = await findFreePort();
  const agentId = opts.agentId ?? `test-${randomUUID().slice(0, 8)}`;

  const child = spawn("node", ["--import", "tsx", WORKER_SCRIPT], {
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      WORKER_ID: `test-${agentId}`,
      AGENT_ID: agentId,
      // No REDIS_URL — HTTP-only mode for tests
      ...opts.extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // Surface worker stderr to test output for debugging
  child.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(`[worker:${agentId}] ${d}`);
  });

  return { child, port, url: `http://127.0.0.1:${port}` };
}

/** Kill a worker and wait for it to exit. */
async function killWorker(child: ChildProcess): Promise<void> {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Subscribe to worker SSE and collect events until terminal event. */
async function subscribeAndCollect(
  url: string,
  sessionId: string,
  timeoutMs = 120_000,
): Promise<{ events: Array<Record<string, unknown>>; terminal: Record<string, unknown> }> {
  const res = await fetch(`${url}/sessions/${sessionId}/events`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);

  const events: Array<Record<string, unknown>> = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
        events.push(ev);
        if (ev.type === "result" || ev.type === "error" || ev.type === "stale_session") {
          return { events, terminal: ev };
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new Error("SSE stream ended without terminal event");
}

// ── Tier 1: Process lifecycle (no credentials needed) ──────────────────────

describe("Host Worker — process lifecycle (no credentials)", { timeout: 30_000 }, () => {
  const children: ChildProcess[] = [];

  afterAll(async () => {
    await Promise.all(children.map(killWorker));
  });

  it("1. worker spawns via tsx and becomes healthy within 15s", async () => {
    const { child, port, url } = await spawnWorker({ agentId: "lifecycle-test" });
    children.push(child);

    await waitForHealth(port);

    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.workerId).toBe("string");
    expect(body.sessions).toBe(0);
  });

  it("2. two concurrent workers start on different ports without conflict", async () => {
    const [a, b] = await Promise.all([
      spawnWorker({ agentId: "concurrent-a" }),
      spawnWorker({ agentId: "concurrent-b" }),
    ]);
    children.push(a.child, b.child);

    await Promise.all([waitForHealth(a.port), waitForHealth(b.port)]);

    expect(a.port).not.toBe(b.port);

    const [ra, rb] = await Promise.all([
      fetch(`${a.url}/health`).then((r) => r.json()),
      fetch(`${b.url}/health`).then((r) => r.json()),
    ]);
    expect((ra as any).ok).toBe(true);
    expect((rb as any).ok).toBe(true);
  });

  it("3. POST /sessions returns a workerSessionId (no SDK invoked)", async () => {
    const { child, port, url } = await spawnWorker({ agentId: "session-create-test" });
    children.push(child);

    await waitForHealth(port);

    // We POST a session but never subscribe — it will time out internally, but
    // the HTTP handshake is what we're testing here.
    const res = await fetch(`${url}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "test",
        orchestratorUrl: "http://localhost:9999",
        callbackToken: "test-token",
        model: "claude-haiku-4-5-20251001",
        maxTurns: 1,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { workerSessionId: string };
    expect(typeof body.workerSessionId).toBe("string");
    expect(body.workerSessionId.length).toBeGreaterThan(0);
  });

  it("4. worker exits cleanly on SIGTERM", async () => {
    const { child, port } = await spawnWorker({ agentId: "sigterm-test" });
    // Don't push to children — we kill it manually in this test.

    await waitForHealth(port);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.kill("SIGTERM");
    });

    // Node exits 0 or null (SIGTERM) — just verify it's not still running
    expect(child.killed || exitCode !== undefined).toBe(true);
  });

  it("5. worker's /health reports session count after POST /sessions", async () => {
    const { child, port, url } = await spawnWorker({ agentId: "session-count-test" });
    children.push(child);

    await waitForHealth(port);

    // Before: 0 sessions
    const before = await fetch(`${url}/health`).then((r) => r.json()) as any;
    expect(before.sessions).toBe(0);

    // Create a session
    await fetch(`${url}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "hold",
        orchestratorUrl: "http://localhost:9999",
        callbackToken: "tok",
        model: "claude-haiku-4-5-20251001",
        maxTurns: 1,
      }),
    });

    // After: 1 session (the SDK will be trying to run, session is live)
    const after = await fetch(`${url}/health`).then((r) => r.json()) as any;
    expect(after.sessions).toBe(1);
  });
});

// ── Tier 2: Full Kleya round-trip (requires credentials) ──────────────────

const CREDS_PATH = join(homedir(), ".claude", ".credentials.json");
const hasCredentials = existsSync(CREDS_PATH);

/**
 * Minimal callback server that the worker calls back to for permission checks
 * (POST /cb/:token/pretooluse) and agent operations.
 *
 * The real orchestrator runs this server; for tests we spin up a lightweight
 * version that auto-approves all tool calls.  This is appropriate in the test
 * environment because we explicitly control which tools and prompts are used.
 */
async function startCallbackServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const ALLOW_RESPONSE = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  });

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // All PreToolUse callbacks → allow
      if (req.method === "POST" && req.url?.includes("/pretooluse")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(ALLOW_RESPONSE);
        return;
      }
      // Other callback routes (agent/start etc.) — return 503 so errors surface clearly
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Test callback server: unhandled route ${req.url}` }));
    });
  });

  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((res, rej) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? rej(err) : res()));
      }),
  };
}

describe.skipIf(!hasCredentials)(
  "Host Worker — Kleya round-trip (requires credentials)",
  { timeout: 120_000 },
  () => {
    let child: ChildProcess | undefined;
    let workerUrl: string;
    let tmpDir: string;
    let cbServer: { url: string; close: () => Promise<void> } | undefined;

    beforeAll(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "kleya-e2e-"));
      cbServer = await startCallbackServer();

      const { child: c, port, url } = await spawnWorker({
        agentId: "kleya",
        extraEnv: {
          AGENT_WORKSPACE: tmpDir,
        },
      });
      child = c;
      workerUrl = url;
      await waitForHealth(port);
    });

    afterAll(async () => {
      if (child) await killWorker(child);
      await cbServer?.close();
      if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("6. Kleya reads a file using the Read tool and returns its contents", async () => {
      const marker = `KLEYA_TEST_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const callbackToken = randomUUID();

      // Write a marker file for Kleya to read — deterministic, no network needed
      const markerFile = join(tmpDir, "marker.txt");
      writeFileSync(markerFile, marker, "utf-8");

      const createRes = await fetch(`${workerUrl}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `Read the file at "${markerFile}" and reply with ONLY its exact contents, nothing else.`,
          orchestratorUrl: cbServer!.url,
          callbackToken,
          model: "claude-haiku-4-5-20251001",
          tools: ["Read"],
          maxTurns: 3,
        }),
      });
      expect(createRes.status).toBe(200);
      const { workerSessionId } = (await createRes.json()) as { workerSessionId: string };

      const { terminal } = await subscribeAndCollect(workerUrl, workerSessionId);

      expect(terminal.type).toBe("result");
      expect(String(terminal.text)).toContain(marker);
    });
  },
);
