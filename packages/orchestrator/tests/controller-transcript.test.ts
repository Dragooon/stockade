import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isResumePlaceholder, latestSessionTitle, projectTranscript, TranscriptReader } from "../src/controller-transcript.js";

describe("TranscriptReader", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "controller-transcript-"));
    file = join(dir, "s.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the newest session title, skipping bad lines, and returns null without one", () => {
    expect(latestSessionTitle(file)).toBeNull();
    writeFileSync(file, '{"uuid":"a"}\n');
    expect(latestSessionTitle(file)).toBeNull();
    writeFileSync(file, '{"type":"ai-title","aiTitle":"Old"}\n{"type":"ai-title","aiTitle":"New"}\n{"uuid":"a"}\n{"type":"ai-title","aiTi');
    expect(latestSessionTitle(file)).toBe("New");
  });

  it("parses appended lines only, waits for a line still being written, and skips corrupt lines", () => {
    const reader = new TranscriptReader();
    writeFileSync(file, '{"uuid":"a"}\n{"uuid":"b"}\nnot json\n{"uuid":"c"');
    expect(reader.read(file).map((r) => r.uuid)).toEqual(["a", "b"]);
    appendFileSync(file, ',"x":1}\n[1,2]\n{"uuid":"d"}\n');
    expect(reader.read(file).map((r) => r.uuid)).toEqual(["a", "b", "c", "d"]);
    expect(reader.read(file)).toHaveLength(4);
  });

  it("starts again when the file shrank, and returns [] for a missing file", () => {
    const reader = new TranscriptReader();
    writeFileSync(file, '{"uuid":"a"}\n{"uuid":"b"}\n');
    expect(reader.read(file)).toHaveLength(2);
    writeFileSync(file, '{"uuid":"z"}\n');
    expect(reader.read(file).map((r) => r.uuid)).toEqual(["z"]);
    expect(reader.read(join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("keeps at most maxFiles parsed, re-reading an evicted file from the start", () => {
    const reader = new TranscriptReader(1);
    const other = join(dir, "o.jsonl");
    writeFileSync(file, '{"uuid":"a"}\n');
    writeFileSync(other, '{"uuid":"o"}\n');
    expect(reader.read(file)).toHaveLength(1);
    expect(reader.read(other)).toHaveLength(1);
    expect(reader.read(file).map((r) => r.uuid)).toEqual(["a"]);
  });
});

describe("isResumePlaceholder", () => {
  const assistant = (model: string, text: string) => ({ type: "assistant", uuid: "u", message: { model, content: [{ type: "text", text }] } });
  it("is the CLI's stub only, not a reply saying the same or an API error", () => {
    expect(isResumePlaceholder(assistant("<synthetic>", "No response requested."))).toBe(true);
    expect(isResumePlaceholder(assistant("claude-opus-5-5", "No response requested."))).toBe(false);
    expect(isResumePlaceholder(assistant("<synthetic>", "API Error: 529"))).toBe(false);
    expect(isResumePlaceholder({ type: "user", uuid: "u", message: { content: "No response requested." } })).toBe(false);
  });
});

describe("projectTranscript", () => {
  it("keeps queued prompts in send order, as text only", () => {
    const projected = projectTranscript([
      { type: "queue-operation", operation: "enqueue", timestamp: "t1", sessionId: "s", content: "second prompt" },
      { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "reply" }, { type: "tool_use", name: "Bash" }] } },
      { type: "queue-operation", operation: "dequeue", timestamp: "t2", sessionId: "s" },
      { type: "attachment", uuid: "q1", cwd: "/secret", attachment: { type: "queued_command", prompt: "second prompt", source_uuid: "x" } },
    ]);
    expect(projected).toEqual([
      { type: "queue-operation", operation: "enqueue", timestamp: "t1", content: "second prompt", id: "line-0" },
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
      { type: "queue-operation", operation: "dequeue", timestamp: "t2", id: "line-2" },
      { type: "attachment", uuid: "q1", attachment: { type: "queued_command", prompt: "second prompt" } },
    ]);
  });

  it("drops task notifications from the queue and other attachments", () => {
    expect(projectTranscript([
      { type: "queue-operation", operation: "enqueue", content: "<task-notification>tool output</task-notification>" },
      { type: "attachment", uuid: "q1", attachment: { type: "queued_command", prompt: "<task-notification>tool output</task-notification>" } },
      { type: "attachment", uuid: "f1", attachment: { type: "file", content: "secret" } },
    ])).toEqual([]);
  });
});
