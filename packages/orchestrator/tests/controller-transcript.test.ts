import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptReader } from "../src/controller-transcript.js";

describe("TranscriptReader", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "controller-transcript-"));
    file = join(dir, "s.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
