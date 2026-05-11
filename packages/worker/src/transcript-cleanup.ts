/**
 * Transcript cleanup for SDK session resume.
 *
 * Background: when the worker is killed mid-tool-call (e.g. orchestrator restart
 * during a long-running browse subagent), the SDK's persisted JSONL transcript
 * ends with an assistant `tool_use` block that has no matching `tool_result`.
 * On resume the SDK injects a synthetic `assistant: "No response requested."`
 * text block but does NOT close the tool_use chain — so the model sees an
 * unanswered prior request, and any short follow-up message from the user
 * gets re-interpreted as a retry of the abandoned task.
 *
 * Fix: before the SDK reads the JSONL on resume, find any user turn that
 * contains a dangling tool_use and truncate the file at that point. The
 * abandoned turn vanishes from the model's context. Healthy prior history
 * is preserved.
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface JsonlRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

function projectsSlug(cwd: string): string {
  // SDK encodes a project dir into ~/.claude/projects/<slug>/. The slug is
  // the absolute path with separators replaced by dashes. On Linux containers
  // /workspace → -workspace.
  return cwd.replace(/[\\/]/g, "-");
}

function sessionPath(sessionId: string, cwd: string): string {
  return join(homedir(), ".claude", "projects", projectsSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * Remove any unfinished turn (user message followed by a tool_use without a
 * matching tool_result) from the end of the SDK transcript for this session.
 *
 * Returns true if the file was modified, false otherwise.
 */
export async function trimDanglingToolUse(
  sessionId: string,
  cwd: string,
): Promise<boolean> {
  const path = sessionPath(sessionId, cwd);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return false; // No transcript yet — fresh session, nothing to clean.
  }

  const lines = raw.split("\n");
  const records: { line: string; rec: JsonlRecord; idx: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      records.push({ line, rec: JSON.parse(line), idx: i });
    } catch {
      // Preserve unparseable lines as opaque — but track index so we don't lose them.
      records.push({ line, rec: {}, idx: i });
    }
  }
  if (records.length === 0) return false;

  // Collect tool_use IDs and matched tool_result IDs across the whole transcript.
  const toolUseIds = new Set<string>();
  const resolvedIds = new Set<string>();
  for (const { rec } of records) {
    const blocks = rec.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      const block = b as Record<string, unknown>;
      if (block.type === "tool_use" && typeof block.id === "string") {
        toolUseIds.add(block.id);
      }
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        resolvedIds.add(block.tool_use_id);
      }
    }
  }
  const dangling = new Set([...toolUseIds].filter((id) => !resolvedIds.has(id)));
  if (dangling.size === 0) return false;

  // Find the earliest record that emits a dangling tool_use.
  let firstBadIdx = -1;
  for (let i = 0; i < records.length; i++) {
    const blocks = records[i].rec.message?.content;
    if (!Array.isArray(blocks)) continue;
    const hits = blocks.some((b) => {
      if (!b || typeof b !== "object") return false;
      const block = b as Record<string, unknown>;
      return block.type === "tool_use" && typeof block.id === "string" && dangling.has(block.id);
    });
    if (hits) {
      firstBadIdx = i;
      break;
    }
  }
  if (firstBadIdx === -1) return false;

  // Walk back to the user message that originated this turn. Skip across
  // user records that are themselves tool_results (continuations of the same
  // turn) and assistant records.
  let cutIdx = firstBadIdx;
  while (cutIdx > 0) {
    const prev = records[cutIdx - 1].rec;
    const role = prev.message?.role;
    if (role === "assistant") {
      cutIdx--;
      continue;
    }
    if (role === "user") {
      const blocks = prev.message?.content;
      const isToolResult = Array.isArray(blocks) && blocks.some((b) => {
        if (!b || typeof b !== "object") return false;
        return (b as Record<string, unknown>).type === "tool_result";
      });
      if (isToolResult) {
        cutIdx--;
        continue;
      }
      // Fresh user prompt — this is the start of the abandoned turn. Cut here.
      cutIdx--;
      break;
    }
    // Other record types (queue-operation, last-prompt, etc.) — keep walking back.
    cutIdx--;
  }

  if (cutIdx === records.length) return false;

  const droppedCount = records.length - cutIdx;
  const kept = records.slice(0, cutIdx).map((r) => r.line);
  const newContent = kept.length > 0 ? kept.join("\n") + "\n" : "";
  await writeFile(path, newContent, "utf8");

  console.log(
    `[worker] resume cleanup: dropped ${droppedCount} record(s) with dangling tool_use(s) ` +
    `[${[...dangling].slice(0, 3).map((id) => id.slice(0, 12)).join(",")}] from ${path}`,
  );
  return true;
}
