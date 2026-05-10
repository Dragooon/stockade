/**
 * Host-side bash executor.
 *
 * Sandboxed agents (e.g. Madge) call `mcp__host__bash` to run a whitelisted
 * command on the host machine itself — outside their container. The MCP tool
 * lives in the worker; the worker POSTs to /cb/:token/host-bash; this module
 * runs the command and returns stdout/stderr/exitCode.
 *
 * Permission gating happens twice:
 *   1. PreToolUse hook (in the worker's Claude SDK) blocks the model from even
 *      calling the tool unless an `allow:Bash:host(<glob>)` rule matches.
 *   2. The /host-bash endpoint re-evaluates the same rule before exec — defense
 *      in depth, since the worker is across a trust boundary.
 *
 * Output is capped at 1 MB per stream to prevent runaway commands from
 * blowing up the orchestrator's heap.
 */

import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface HostBashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * Pick the shell to run host commands through.
 *
 * Prefers `bash` (Git Bash on Windows, /bin/bash on Unix) so that the
 * POSIX-style allowlists kleya already used (pipes, globs, `&&`, etc.)
 * keep working. Override with HOST_BASH_SHELL if needed.
 */
function pickShell(): { shell: string; flag: string } {
  const override = process.env.HOST_BASH_SHELL;
  if (override) {
    return { shell: override, flag: "-c" };
  }
  if (process.platform === "win32") {
    return { shell: "bash.exe", flag: "-c" };
  }
  return { shell: "/bin/bash", flag: "-c" };
}

/**
 * Run a single shell command on the host. Returns combined stdout/stderr,
 * the exit code, and flags for timeout / output truncation.
 */
export async function runHostCommand(
  command: string,
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<HostBashResult> {
  const { shell, flag } = pickShell();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn(shell, [flag, command], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (target: "out" | "err", chunk: Buffer) => {
      const cur = target === "out" ? stdout : stderr;
      if (cur.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const remaining = MAX_OUTPUT_BYTES - cur.length;
      const text = chunk.toString("utf8");
      if (text.length > remaining) {
        truncated = true;
        if (target === "out") stdout = cur + text.slice(0, remaining);
        else stderr = cur + text.slice(0, remaining);
      } else {
        if (target === "out") stdout = cur + text;
        else stderr = cur + text;
      }
    };

    child.stdout.on("data", (c) => append("out", c));
    child.stderr.on("data", (c) => append("err", c));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finalize = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut, truncated });
    };

    child.on("error", (err) => {
      stderr += `[host-bash spawn error] ${err.message}\n`;
      finalize(127);
    });
    child.on("close", (code) => finalize(code ?? (timedOut ? 124 : 1)));
  });
}
