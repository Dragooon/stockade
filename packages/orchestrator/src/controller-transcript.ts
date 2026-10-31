/**
 * Raw transcript records for the controller API (D3b §5): the SDK's append-only JSONL,
 * parsed incrementally. Each read parses only the bytes appended since the last one, so
 * polling a live session once a second stays cheap. A file that shrank (rewritten) is
 * parsed again from the start.
 */

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

/** One raw record of a Claude Code transcript (a parsed JSONL line). */
export type TranscriptRecord = Record<string, unknown>;

interface CachedFile {
  /** Bytes parsed so far: always just after a newline. */
  offset: number;
  records: TranscriptRecord[];
}

const CHUNK_BYTES = 4 * 1024 * 1024;
const TITLE_TAIL_BYTES = 256 * 1024;

/**
 * The title Claude Code gave a session: the last `ai-title` record near the end of its JSONL.
 * Reads only the tail, so it's cheap enough to call for every row of a list.
 */
export function latestSessionTitle(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(TITLE_TAIL_BYTES, size);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].includes('"ai-title"')) continue;
      try {
        const record = JSON.parse(lines[index]);
        if (record?.type === "ai-title" && typeof record.aiTitle === "string" && record.aiTitle.trim()) {
          return record.aiTitle.trim();
        }
      } catch {
        // The tail can start mid-line, and a line can be half written.
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

export class TranscriptReader {
  private files = new Map<string, CachedFile>();

  /**
   * @param maxFiles files kept parsed in memory, least recently read dropped first. A long
   *   session (24 MB of JSONL) holds about 40 MB of heap.
   */
  constructor(private readonly maxFiles = 6) {}

  /** Every complete record in the file, oldest first. A line still being written waits for the next read. */
  read(path: string): TranscriptRecord[] {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      this.files.delete(path);
      return [];
    }
    let cached = this.files.get(path);
    if (!cached || size < cached.offset) cached = { offset: 0, records: [] };
    // Re-insert so the map's order is least recently read first.
    this.files.delete(path);
    this.files.set(path, cached);
    while (this.files.size > this.maxFiles) this.files.delete(this.files.keys().next().value!);
    if (size > cached.offset) this.parseAppended(path, cached, size);
    return cached.records;
  }

  private parseAppended(path: string, cached: CachedFile, size: number): void {
    const fd = openSync(path, "r");
    try {
      let position = cached.offset;
      let carry = Buffer.alloc(0);
      while (position < size) {
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
        const read = readSync(fd, buffer, 0, buffer.length, position);
        if (read <= 0) break;
        position += read;
        const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, read)]) : buffer.subarray(0, read);
        const lastNewline = data.lastIndexOf(0x0a);
        if (lastNewline < 0) {
          carry = data;
          continue;
        }
        carry = data.subarray(lastNewline + 1);
        for (const line of data.subarray(0, lastNewline).toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            if (record && typeof record === "object" && !Array.isArray(record)) cached.records.push(record);
          } catch {
            // A corrupt line is skipped, as the transcript index does.
          }
        }
      }
      cached.offset = position - carry.length;
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * The placeholder the CLI writes on resume after a turn that was cut off before answering.
 * Nobody wrote it, so no reader sees it.
 */
export function isResumePlaceholder(record: TranscriptRecord): boolean {
  if (record.type !== "assistant") return false;
  const message = record.message as { model?: unknown; content?: unknown } | undefined;
  if (message?.model !== "<synthetic>") return false;
  const blocks = textBlocks(message.content);
  return blocks.length === 1 && blocks[0].text === "No response requested.";
}

/** The id a client pages by: the record's uuid, or `line-<n>` for the few record types without one. */
export function transcriptRecordId(record: TranscriptRecord, index: number): string {
  if (typeof record.uuid === "string" && record.uuid) return record.uuid;
  if (typeof record.id === "string" && record.id) return record.id;
  return `line-${index}`;
}

/** Records with an id the client can page by: records without a uuid get `id: "line-<n>"`. */
export function withRecordIds(records: TranscriptRecord[]): TranscriptRecord[] {
  return records.map((record, index) =>
    typeof record.uuid === "string" && record.uuid ? record : { ...record, id: transcriptRecordId(record, index) });
}

function textBlocks(content: unknown): Array<{ type: "text"; text: string }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is { type: "text"; text: string } =>
      !!block && typeof block === "object" && block.type === "text" && typeof block.text === "string" && block.text.trim() !== "")
    .map((block) => ({ type: "text", text: block.text }));
}

/** A queued prompt's text, or "" for what isn't one: a task notification carries tool output. */
function queuedPromptText(content: unknown): string {
  const text = typeof content === "string" ? content : textBlocks(content).map((block) => block.text).join("\n");
  return text.trimStart().startsWith("<task-notification") ? "" : text;
}

/**
 * The projection `mcp__sessions__read` shows (D3b §5), in the raw-record shape: user and
 * assistant text only, plus the queue records that say when a prompt was sent, so a client
 * can keep send order. No tool calls, tool output, thinking, other attachments, cwd or
 * sidechains, so tool output fetched for other people never reaches the app.
 */
export function projectTranscript(records: TranscriptRecord[]): TranscriptRecord[] {
  const projected: TranscriptRecord[] = [];
  for (const record of records) {
    if (record.isSidechain) continue;
    if (record.type === "queue-operation") {
      const time = typeof record.timestamp === "string" ? { timestamp: record.timestamp } : {};
      if (record.operation === "dequeue") projected.push({ type: "queue-operation", operation: "dequeue", ...time });
      if (record.operation !== "enqueue") continue;
      const content = queuedPromptText(record.content);
      if (content.trim()) projected.push({ type: "queue-operation", operation: "enqueue", ...time, content });
      continue;
    }
    if (typeof record.uuid !== "string") continue;
    const message = record.message as { content?: unknown; id?: unknown; model?: unknown } | undefined;
    const base = {
      uuid: record.uuid,
      ...(typeof record.timestamp === "string" ? { timestamp: record.timestamp } : {}),
      ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
    };
    if (record.type === "user") {
      if (record.isMeta) continue;
      const content = message?.content;
      if (typeof content === "string") {
        if (!content.trim() || content.startsWith("<command-") || content.startsWith("<local-command")) continue;
        projected.push({ type: "user", ...base, message: { role: "user", content } });
        continue;
      }
      const blocks = textBlocks(content);
      if (blocks.length) projected.push({ type: "user", ...base, message: { role: "user", content: blocks } });
      continue;
    }
    if (record.type === "assistant") {
      const blocks = textBlocks(message?.content);
      if (!blocks.length) continue;
      projected.push({
        type: "assistant",
        ...base,
        message: {
          role: "assistant",
          ...(typeof message?.id === "string" ? { id: message.id } : {}),
          ...(typeof message?.model === "string" ? { model: message.model } : {}),
          content: blocks,
        },
      });
      continue;
    }
    const attachment = record.attachment as { type?: unknown; prompt?: unknown } | undefined;
    if (record.type === "attachment" && attachment?.type === "queued_command") {
      const prompt = queuedPromptText(attachment.prompt);
      if (prompt.trim()) projected.push({ type: "attachment", ...base, attachment: { type: "queued_command", prompt } });
    }
  }
  return withRecordIds(projected);
}
