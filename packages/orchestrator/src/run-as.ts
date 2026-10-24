/**
 * Host mode with OS-user isolation (agent `host_user` / `sudo_user`).
 *
 * The worker runs as the platform user and starts each Claude session as the
 * agent's OS user via `sudo -u`. This module resolves where such a session runs:
 * which user, its home (the SDK cwd), the directories it gets via --add-dir,
 * and where its transcripts land.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "./types.js";

export interface RunAs {
  user: string;
  home: string;
  /** SDK cwd: the user's home, never a folder another user can write. */
  cwd: string;
  /** --add-dir: the agent workspace (CLAUDE.md, skills, memory). */
  addDirs: string[];
  /** The agent workspace (memory lives in <workspace>/memory). */
  workspace: string;
  sudo: boolean;
}

/** Home directory of a local user, from /etc/passwd. */
export function passwdHome(user: string, passwdFile = "/etc/passwd"): string {
  for (const line of readFileSync(passwdFile, "utf-8").split("\n")) {
    const f = line.split(":");
    if (f[0] === user && f[5]) return f[5];
  }
  throw new Error(`No such user: ${user}`);
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
  return { user, home, cwd: home, addDirs: [host.workspace], workspace: host.workspace, sudo };
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
