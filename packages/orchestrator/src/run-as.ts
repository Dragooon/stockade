/**
 * Host mode with OS-user isolation (agent `host_user` / `sudo_user`).
 *
 * The worker runs as the platform user and starts each Claude session as the
 * agent's OS user via `sudo -u`. This module resolves where such a session runs:
 * which user, its home (the SDK cwd), the directories it gets via --add-dir,
 * and where its transcripts land.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { AgentConfig } from "./types.js";

export interface RunAs {
  user: string;
  uid?: number;
  home: string;
  /** SDK cwd: the user's home, never a folder another user can write. */
  cwd: string;
  /** --add-dir: the agent workspace (CLAUDE.md, skills, memory). */
  addDirs: string[];
  /** The agent workspace (memory lives in <workspace>/memory). */
  workspace: string;
  sudo: boolean;
}

/** A local user's /etc/passwd entry (uid and home). */
export function passwdEntry(user: string, passwdFile = "/etc/passwd"): { uid: number; home: string } {
  for (const line of readFileSync(passwdFile, "utf-8").split("\n")) {
    const f = line.split(":");
    if (f[0] === user && f[5]) return { uid: Number(f[2]), home: f[5] };
  }
  throw new Error(`No such user: ${user}`);
}

/** Home directory of a local user, from /etc/passwd. */
export function passwdHome(user: string, passwdFile = "/etc/passwd"): string {
  return passwdEntry(user, passwdFile).home;
}

/**
 * Resolve the OS user a session of this agent runs as, or undefined for
 * agents without host_user (containers, legacy host workers).
 * Throws for a sudo session on an agent that has no sudo_user.
 */
export function resolveRunAs(
  agentConfig: AgentConfig,
  sudo: boolean,
  homeOf: (user: string) => string = passwdHome,
): RunAs | undefined {
  const host = agentConfig.host_user;
  if (!host) {
    if (sudo) throw new Error("This agent has no sudo user");
    return undefined;
  }
  const user = sudo ? agentConfig.sudo_user?.user : host.user;
  if (!user) throw new Error("This agent has no sudo user");
  const home = homeOf(user);
  let uid: number | undefined;
  try { uid = passwdEntry(user).uid; } catch { /* tests with a fake homeOf */ }
  return { user, uid, home, cwd: home, addDirs: [host.workspace], workspace: host.workspace, sudo };
}

/** Transcript folders (~/.claude/projects) of every OS user this agent runs as. */
export function agentTranscriptDirs(
  agentConfig: AgentConfig,
  homeOf: (user: string) => string = passwdHome,
): string[] {
  const users = [agentConfig.host_user?.user, agentConfig.sudo_user?.user].filter((u): u is string => !!u);
  const dirs: string[] = [];
  for (const u of users) {
    try { dirs.push(join(homeOf(u), ".claude", "projects")); } catch { /* user missing */ }
  }
  return dirs;
}

/** Folder under ~/.claude/projects where the CLI keeps transcripts for a cwd. */
export function projectDir(home: string, cwd: string): string {
  return join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

/**
 * Hand a conversation's transcript to the user a session is about to run as. A conversation
 * switched with /sudo moves between OS users, and the CLI only resumes from its own
 * ~/.claude/projects (files are 0600, so the users can't share one). It's a move, not a copy:
 * the newest version goes to the target and the other user's copy is deleted, so there is only
 * ever one transcript per conversation and nothing can drift. Reads with the orchestrator's
 * CAP_DAC_READ_SEARCH; writes and deletes as the owning users via `sudo -u` (tar, so the
 * session's side files move too). Throws if the hand-over fails: never resume a stale copy.
 */
export async function syncTranscript(
  sessionId: string,
  target: RunAs,
  others: RunAs[],
): Promise<"present" | "moved" | "missing"> {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return "missing";
  const mtime = (p: string) => { try { return statSync(p).mtimeMs; } catch { return -1; } };
  const destDir = projectDir(target.home, target.cwd);
  const destTime = mtime(join(destDir, `${sessionId}.jsonl`));
  let best: { dir: string; time: number; user: string } | undefined;
  for (const o of others) {
    const dir = projectDir(o.home, o.cwd);
    const t = mtime(join(dir, `${sessionId}.jsonl`));
    if (t > (best?.time ?? -1)) best = { dir, time: t, user: o.user };
  }
  if (!best) return destTime >= 0 ? "present" : "missing";
  const items = [`${sessionId}.jsonl`, ...(existsSync(join(best.dir, sessionId)) ? [sessionId] : [])];
  const removeSource = () => runAs(best!.user, ["sh", "-c", 'cd "$1" && shift && rm -rf -- "$@"', "sh", best!.dir, ...items]);
  if (best.time <= destTime) {
    // A leftover older copy on the other side (e.g. from before moves): drop it.
    await removeSource();
    return "present";
  }

  await new Promise<void>((resolve, reject) => {
    const src = spawn("tar", ["-C", best!.dir, "-cf", "-", ...items], { stdio: ["ignore", "pipe", "pipe"] });
    const dst = spawn("sudo", ["-n", "-u", target.user, "--", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin",
      "sh", "-c", 'mkdir -p "$1" && tar -C "$1" -xf -', "sh", destDir], { stdio: ["pipe", "ignore", "pipe"] });
    src.stdout.pipe(dst.stdin);
    let err = "";
    src.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    dst.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    let pending = 2, failed = false;
    const done = (code: number | null) => {
      if (code !== 0) failed = true;
      if (--pending === 0) (failed ? reject(new Error(err.trim() || "transcript copy failed")) : resolve());
    };
    src.on("close", done);
    dst.on("close", done);
    src.on("error", reject);
    dst.on("error", reject);
  });
  await removeSource();
  return "moved";
}

/** Run a command as `user` (sudo -n -u … env -i), rejecting on a non-zero exit. */
function runAs(user: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn("sudo", ["-n", "-u", user, "--", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", ...argv], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`))));
  });
}
