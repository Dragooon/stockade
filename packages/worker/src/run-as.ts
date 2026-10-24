/**
 * Run-as support: the worker (platform user) starts each Claude session as the
 * agent's OS user via `sudo -n -u <user> -- /usr/bin/env -i <env> <cmd>`.
 *
 * Needs a sudoers rule like:
 *   stockade ALL=(madge,madge-sudo) NOPASSWD: /usr/bin/env
 *
 * The child gets a clean environment: an allowlist of the SDK's variables plus
 * what the orchestrator asked for. Nothing from the worker's own environment
 * (bus address, worker auth token) reaches it.
 */

import { spawn } from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

export interface RunAsTarget {
  user: string;
  home: string;
}

/** Never passed to a run-as child, whatever the caller asked for. */
const BLOCKED_ENV = new Set(["REDIS_URL", "WORKER_AUTH_TOKEN", "STOCKADE_API_TOKEN", "DISCORD_TOKEN"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Base environment for a session running as `target`. */
export function baseEnv(target: RunAsTarget): Record<string, string> {
  return {
    HOME: target.home,
    USER: target.user,
    LOGNAME: target.user,
    SHELL: "/bin/bash",
    PATH: `${target.home}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin`,
    LANG: process.env.LANG ?? "C.UTF-8",
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
  };
}

/** The `env -i` argument list for a child environment, dropping blocked or malformed names. */
export function envArgs(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || BLOCKED_ENV.has(k) || !ENV_NAME.test(k)) continue;
    out.push(`${k}=${v}`);
  }
  return out;
}

/** sudo argv that runs `command args` as `user` with exactly `env`. */
export function sudoArgv(user: string, env: Record<string, string | undefined>, command: string, args: string[]): string[] {
  return ["-n", "-u", user, "--", "/usr/bin/env", "-i", ...envArgs(env), command, ...args];
}

/** A spawnClaudeCodeProcess implementation that runs the CLI as `target.user`. */
export function runAsSpawner(target: RunAsTarget): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    const child = spawn("sudo", sudoArgv(target.user, options.env, options.command, options.args), {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
      env: { PATH: "/usr/bin:/bin" },
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString().trim();
      if (text) console.error(`[worker] [run-as ${target.user}] ${text}`);
    });
    return child;
  };
}

/**
 * Read a file with `user`'s permissions (for send_file): the worker must not
 * hand the agent anything the agent couldn't read itself.
 */
export function readFileAs(user: string, path: string, maxBytes = 25 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", sudoArgv(user, { PATH: "/usr/bin:/bin" }, "cat", ["--", path]), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) { child.kill("SIGKILL"); return; }
      chunks.push(d);
    });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (size > maxBytes) reject(new Error(`file larger than ${maxBytes} bytes`));
      else if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(err.trim() || `cat exited ${code}`));
    });
  });
}
