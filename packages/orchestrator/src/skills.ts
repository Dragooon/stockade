import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  rmSync,
} from "node:fs";
import type { AgentsConfig } from "./types.js";

const GLOBAL_SKILLS_DIR = join(homedir(), ".claude", "skills");

/**
 * Sync skills from ~/.claude/skills/ into each agent's workspace.
 *
 * For each agent with a `skills` list, recursively copies skill directories
 * from ~/.claude/skills/<name> into ~/.stockade/agents/<id>/.claude/skills/<name>.
 * A marker file `.synced` is written inside each copied directory so that
 * the cleanup pass can distinguish synced copies from agent-specific skills.
 *
 * - Synced skill directories that are no longer in config are removed.
 * - Old symlinks/junctions (from the previous approach) are removed.
 * - Non-synced directories (agent-specific skills) are never touched.
 */
export function syncAgentSkills(
  agents: AgentsConfig,
  agentsDir: string,
): void {
  for (const [agentId, agentConfig] of Object.entries(agents.agents)) {
    // Use workspace_host_path for WSL2-backed agents, otherwise default path.
    // Skip workspace_path — it may be a Docker volume name, not a filesystem path.
    const workspaceRoot = agentConfig.container?.workspace_host_path ?? resolve(agentsDir, agentId);
    const targetSkillsDir = resolve(workspaceRoot, ".claude", "skills");
    const wantedSkills = new Set(agentConfig.skills ?? []);

    // If agent has skills config, ensure the directory exists
    if (wantedSkills.size > 0) {
      mkdirSync(targetSkillsDir, { recursive: true });
    } else if (!existsSync(targetSkillsDir)) {
      continue;
    }

    // Scan existing entries — clean up stale synced copies and old symlinks
    if (existsSync(targetSkillsDir)) {
      for (const entry of readdirSync(targetSkillsDir)) {
        const entryPath = join(targetSkillsDir, entry);
        const stat = lstatSync(entryPath);

        if (stat.isSymbolicLink()) {
          // Old junction/symlink from the previous approach — always remove
          rmSync(entryPath, { force: true });
          console.log(`[skills] removed ${agentId}/${entry} (old symlink, migrating to copy)`);
          continue;
        }

        if (!stat.isDirectory()) {
          // Not a directory — leave it alone
          continue;
        }

        const isSynced = existsSync(resolve(entryPath, ".synced"));
        if (!isSynced) {
          // Agent-specific skill (no marker) — leave it alone
          continue;
        }

        if (!wantedSkills.has(entry)) {
          // Synced copy for a skill no longer in config — remove it
          rmSync(entryPath, { recursive: true, force: true });
          console.log(`[skills] removed ${agentId}/${entry} (no longer in config)`);
        }
      }
    }

    // Copy wanted skills into the target directory
    for (const skillName of wantedSkills) {
      const source = join(GLOBAL_SKILLS_DIR, skillName);
      const target = join(targetSkillsDir, skillName);

      if (!existsSync(source)) {
        console.warn(`[skills] ${agentId}: skill "${skillName}" not found in ${GLOBAL_SKILLS_DIR}`);
        continue;
      }

      if (existsSync(target)) {
        // Already exists — skip (copy is not re-synced on every run)
        continue;
      }

      try {
        cpSync(source, target, { recursive: true });
        writeFileSync(resolve(target, ".synced"), "", "utf-8");
        console.log(`[skills] ${agentId}/${skillName} copied from ${source}`);
      } catch (err) {
        console.error(
          `[skills] failed to copy ${agentId}/${skillName}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
