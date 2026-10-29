import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROLLER_FILE_MAX_BYTES,
  CONTROLLER_FILES_MAX_PENDING,
  CONTROLLER_FILE_TTL_MS,
  ControllerFileStore,
  cleanFilename,
  uniqueNames,
} from "../src/controller-files.js";

const APP = "app:shitiz:a1";
const OTHER_APP = "app:shitiz:b2";

describe("cleanFilename", () => {
  it("percent-decodes the header", () => {
    expect(cleanFilename("caf%C3%A9%20menu.png")).toBe("café menu.png");
  });

  it("keeps a header that isn't valid percent-encoding as it came", () => {
    expect(cleanFilename("100%.txt")).toBe("100%.txt");
  });

  it("replaces path separators and control characters, drops leading dots", () => {
    expect(cleanFilename("..%2F..%2Fetc%2Fpasswd")).toBe("_.._etc_passwd");
    expect(cleanFilename("a\\b/c\u0000d\n.txt")).toBe("a_b_c_d_.txt");
    expect(cleanFilename(".bashrc")).toBe("bashrc");
  });

  it("falls back to `file` for an empty or missing name", () => {
    expect(cleanFilename(null)).toBe("file");
    expect(cleanFilename("")).toBe("file");
    expect(cleanFilename("...")).toBe("file");
  });

  it("caps long names at 120 characters, keeping a short extension", () => {
    const name = cleanFilename(`${"x".repeat(300)}.jpeg`);
    expect(name).toHaveLength(120);
    expect(name.endsWith(".jpeg")).toBe(true);
  });
});

describe("uniqueNames", () => {
  it("suffixes repeats before the extension", () => {
    expect(uniqueNames(["a.png", "a.png", "b", "a.png", "b"])).toEqual(["a.png", "a-2.png", "b", "a-3.png", "b-2"]);
  });

  it("skips a suffix that is already taken", () => {
    expect(uniqueNames(["a.png", "a-2.png", "a.png"])).toEqual(["a.png", "a-2.png", "a-3.png"]);
  });
});

describe("ControllerFileStore", () => {
  let root: string;
  let dir: string;
  let now: number;
  let store: ControllerFileStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "controller-files-"));
    dir = join(root, "uploads");
    now = Date.parse("2026-10-29T12:00:00.000Z");
    store = new ControllerFileStore({ dir, now: () => now });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const upload = (data: Buffer | string, name = "photo.png", mime = "image/png") =>
    ({ name, mime, data: typeof data === "string" ? Buffer.from(data) : data });

  it("wipes what an earlier run left in its directory", () => {
    writeFileSync(join(dir, "leftover"), "x");
    new ControllerFileStore({ dir });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("stages a file and hands it back once, as a base64 attachment, then deletes it", () => {
    const file = store.stage("shitiz", APP, upload("hello", "note.txt", "text/plain; charset=utf-8"));
    expect(file).toEqual({ id: expect.stringMatching(/^[0-9a-f]{24}$/), name: "note.txt", bytes: 5, mime: "text/plain" });
    expect(readdirSync(dir)).toEqual([file.id]);

    const attachments = store.take("shitiz", APP, [file.id]);
    expect(attachments).toEqual([{ filename: "note.txt", contentType: "text/plain", data: Buffer.from("hello").toString("base64"), size: 5 }]);
    expect(readdirSync(dir)).toEqual([]);
    expect(() => store.take("shitiz", APP, [file.id])).toThrow(expect.objectContaining({ status: 400, code: "unknown_file" }));
  });

  it("keeps the order asked for and makes repeated names unique", () => {
    const first = store.stage("shitiz", APP, upload("1", "a.png"));
    const second = store.stage("shitiz", APP, upload("2", "a.png"));
    const names = store.take("shitiz", APP, [second.id, first.id]).map((attachment) => [attachment.filename, attachment.data]);
    expect(names).toEqual([["a.png", Buffer.from("2").toString("base64")], ["a-2.png", Buffer.from("1").toString("base64")]]);
  });

  it("takes nothing when any id is someone else's, another session's, unknown or repeated", () => {
    const mine = store.stage("shitiz", APP, upload("mine"));
    const theirs = store.stage("urvashi", APP, upload("theirs"));
    const elsewhere = store.stage("shitiz", OTHER_APP, upload("elsewhere"));
    for (const ids of [[mine.id, theirs.id], [mine.id, elsewhere.id], [mine.id, "nope"], [mine.id, mine.id]]) {
      expect(() => store.take("shitiz", APP, ids)).toThrow(expect.objectContaining({ status: 400, code: "unknown_file" }));
    }
    expect(store.take("shitiz", APP, [mine.id])).toHaveLength(1);
    expect(store.pendingCount("urvashi")).toBe(1);
  });

  it("refuses an empty file and one over 25 MB", () => {
    expect(() => store.stage("shitiz", APP, upload(""))).toThrow(expect.objectContaining({ status: 400, code: "empty_file" }));
    expect(() => store.stage("shitiz", APP, upload(Buffer.alloc(CONTROLLER_FILE_MAX_BYTES + 1))))
      .toThrow(expect.objectContaining({ status: 413, code: "too_large" }));
    expect(readdirSync(dir)).toEqual([]);
  });

  it("caps how many files one person has waiting, not others", () => {
    for (let index = 0; index < CONTROLLER_FILES_MAX_PENDING; index++) store.stage("shitiz", APP, upload(`f${index}`));
    expect(() => store.stage("shitiz", APP, upload("one more"))).toThrow(expect.objectContaining({ status: 413, code: "quota" }));
    expect(store.stage("urvashi", APP, upload("someone else"))).toMatchObject({ bytes: 12 });
  });

  it("expires unsent files after 24 hours", () => {
    const file = store.stage("shitiz", APP, upload("old"));
    now += CONTROLLER_FILE_TTL_MS - 1;
    store.sweep();
    expect(store.pendingCount("shitiz")).toBe(1);
    now += 1;
    expect(() => store.take("shitiz", APP, [file.id])).toThrow(expect.objectContaining({ code: "unknown_file" }));
    expect(existsSync(join(dir, file.id))).toBe(false);
  });

  it("stores what prepare returns, reporting the uploaded size to the app and the stored size to the agent", () => {
    const shrinking = new ControllerFileStore({ dir: join(root, "shrunk"), prepare: (data, mime) => (mime.startsWith("image/") ? data.subarray(0, 2) : data) });
    const file = shrinking.stage("shitiz", APP, upload("abcdef"));
    expect(file.bytes).toBe(6);
    expect(shrinking.take("shitiz", APP, [file.id])).toEqual([
      { filename: "photo.png", contentType: "image/png", data: Buffer.from("ab").toString("base64"), size: 2 },
    ]);
  });

  it("falls back to application/octet-stream for a missing or malformed type", () => {
    expect(store.stage("shitiz", APP, upload("x", "a", "")).mime).toBe("application/octet-stream");
    expect(store.stage("shitiz", APP, upload("x", "a", "not a type")).mime).toBe("application/octet-stream");
    expect(store.stage("shitiz", APP, upload("x", "a", "IMAGE/JPEG")).mime).toBe("image/jpeg");
  });

  it("creates its directory when it doesn't exist yet", () => {
    const nested = join(root, "a", "b");
    mkdirSync(join(root, "a"));
    new ControllerFileStore({ dir: nested });
    expect(existsSync(nested)).toBe(true);
  });
});
