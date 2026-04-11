import { join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import type { AgentsConfig } from "./types.js";

/**
 * Ensure the platform-level skills directory exists.
 *
 * Skills now live at <platformRoot>/.claude/skills/ — a single shared directory
 * that all agents read from. For host agents, sdkCwd = platformRoot so the SDK
 * picks up skills automatically. For sandboxed agents, the container provisioner
 * mounts this directory at /workspace/.claude/skills/.
 *
 * Agents can edit skills directly in this directory; changes are immediately
 * visible to all agents on the next dispatch (no restart, no copy).
 *
 * Per-agent filtering is done via permission rules:
 *   deny:Skill(platform-admin)   — hides a skill from context entirely (0 tokens)
 *   deny:Skill(*)                — hides all skills
 *   allow:Skill(commit)          — explicit allowlist
 */
export function ensurePlatformSkillsDir(platformRoot: string): void {
  const skillsDir = resolve(platformRoot, ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  console.log(`[skills] platform skills dir: ${skillsDir}`);
}

/**
 * One-time migration: remove old synced skill copies from agent workspaces.
 *
 * Previous versions copied skills from ~/.claude/skills/ into each agent's
 * ~/.stockade/agents/<id>/.claude/skills/<name>/ with a .synced marker file.
 * These copies are now redundant — the platform skills dir is mounted/loaded
 * centrally. This cleans them up on first run after upgrade.
 */
export function migrateSyncedCopies(agentsDir: string): void {
  if (!existsSync(agentsDir)) return;

  for (const agentId of readdirSync(agentsDir)) {
    const agentSkillsDir = join(agentsDir, agentId, ".claude", "skills");
    if (!existsSync(agentSkillsDir)) continue;

    let removed = 0;
    for (const entry of readdirSync(agentSkillsDir)) {
      const entryPath = join(agentSkillsDir, entry);
      let stat;
      try {
        stat = lstatSync(entryPath);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) {
        rmSync(entryPath, { force: true });
        removed++;
        continue;
      }

      if (stat.isDirectory() && existsSync(join(entryPath, ".synced"))) {
        rmSync(entryPath, { recursive: true, force: true });
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[skills] migrated ${agentId}: removed ${removed} old synced copy/copies`);
    }
  }
}

/**
 * @deprecated Skills are no longer synced per-agent. Use ensurePlatformSkillsDir
 * and configure per-agent access via Skill permission rules instead.
 *
 * Kept for backwards compatibility — logs a deprecation warning if any agent
 * still has a non-empty `skills` list in config.
 */
export function syncAgentSkills(agents: AgentsConfig, _agentsDir: string): void {
  for (const [agentId, agentConfig] of Object.entries(agents.agents)) {
    if (agentConfig.skills?.length) {
      console.warn(
        `[skills] ${agentId}: "skills" config field is deprecated. ` +
        `Skills now load from the platform skills dir (~/.stockade/.claude/skills/). ` +
        `Use permission rules (deny:Skill(name)) to restrict per-agent access.`,
      );
    }
  }
}
