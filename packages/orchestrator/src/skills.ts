import { join } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import type { AgentsConfig } from "./types.js";

const GLOBAL_SKILLS_DIR = join(homedir(), ".claude", "skills");

/**
 * Sync skills from ~/.claude/skills/ into each agent's workspace.
 *
 * For each agent with a `skills` list, creates directory junctions
 * (symlinks on Unix) from ~/.stockade/agents/<id>/.claude/skills/<name>
 * pointing to ~/.claude/skills/<name>.
 *
 * - Junctions that point to missing source skills are removed.
 * - Junctions for skills no longer in config are removed.
 * - Non-junction directories (agent-specific skills) are never touched.
 */
export function syncAgentSkills(
  agents: AgentsConfig,
  agentsDir: string,
): void {
  for (const [agentId, agentConfig] of Object.entries(agents.agents)) {
    const targetSkillsDir = join(agentsDir, agentId, ".claude", "skills");
    const wantedSkills = new Set(agentConfig.skills ?? []);

    // If agent has skills config, ensure the directory exists
    if (wantedSkills.size > 0) {
      mkdirSync(targetSkillsDir, { recursive: true });
    } else if (!existsSync(targetSkillsDir)) {
      continue;
    }

    // Scan existing entries — clean up stale junctions
    if (existsSync(targetSkillsDir)) {
      for (const entry of readdirSync(targetSkillsDir)) {
        const entryPath = join(targetSkillsDir, entry);
        const stat = lstatSync(entryPath);

        if (!stat.isSymbolicLink()) {
          // Not a junction/symlink — agent-specific skill, leave it alone
          continue;
        }

        if (!wantedSkills.has(entry)) {
          // Junction for a skill no longer in config — remove it
          rmSync(entryPath, { force: true });
          console.log(`[skills] removed ${agentId}/${entry} (no longer in config)`);
        } else {
          // Verify the junction target still exists
          try {
            const target = readlinkSync(entryPath);
            if (!existsSync(target)) {
              rmSync(entryPath, { force: true });
              console.log(`[skills] removed ${agentId}/${entry} (source missing)`);
            }
          } catch {
            // Broken symlink — remove
            rmSync(entryPath, { force: true });
          }
        }
      }
    }

    // Create junctions for wanted skills
    for (const skillName of wantedSkills) {
      const source = join(GLOBAL_SKILLS_DIR, skillName);
      const target = join(targetSkillsDir, skillName);

      if (!existsSync(source)) {
        console.warn(`[skills] ${agentId}: skill "${skillName}" not found in ${GLOBAL_SKILLS_DIR}`);
        continue;
      }

      if (existsSync(target)) {
        // Already exists (junction or real dir) — skip
        continue;
      }

      try {
        // 'junction' works on Windows without admin, 'dir' symlink on Unix
        symlinkSync(source, target, "junction");
        console.log(`[skills] ${agentId}/${skillName} → ${source}`);
      } catch (err) {
        console.error(
          `[skills] failed to link ${agentId}/${skillName}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
