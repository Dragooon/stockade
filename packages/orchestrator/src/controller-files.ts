/**
 * Files a controller app uploads before sending them (capability `files`).
 *
 * POST sessions/:id/files stages the bytes here, scoped to the person and the session; a
 * message then names them by id and takes them (single use). Taken files go to the agent the
 * way Discord attachments do: saved under its workspace, listed in the prompt. Unsent files
 * expire after CONTROLLER_FILE_TTL_MS. The index lives in memory and the directory is wiped
 * at startup, so a restart forgets pending uploads (the app re-uploads on `unknown_file`).
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControllerError } from "./controller.js";
import type { ChannelAttachment } from "./types.js";

/** Per file, the same as Discord's attachment limit. */
export const CONTROLLER_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** Unsent files one person may have staged at once, by count and by total size. */
export const CONTROLLER_FILES_MAX_PENDING = 20;
export const CONTROLLER_FILES_MAX_PENDING_BYTES = 200 * 1024 * 1024;
export const CONTROLLER_FILE_TTL_MS = 24 * 60 * 60 * 1000;
/** Files one message may carry. */
export const CONTROLLER_MESSAGE_MAX_FILES = 10;
export const CONTROLLER_FILENAME_MAX_CHARS = 120;

/** What the app is told about an upload. */
export interface ControllerFile {
  id: string;
  name: string;
  bytes: number;
  mime: string;
}

interface StagedFile extends ControllerFile {
  person: string;
  scope: string;
  path: string;
  /** Size on disk, after prepare (an image shrunk to 2000 px), for the quota and the prompt. */
  storedBytes: number;
  createdAt: number;
}

export interface ControllerFileStoreOptions {
  /** Where staged files live; wiped when the store is created. */
  dir: string;
  now?: () => number;
  /** Turn the uploaded bytes into what the agent gets (Discord's image resize). Default: as is. */
  prepare?: (data: Buffer, mime: string) => Buffer;
}

/**
 * The name the app sent, made safe as a file name: percent-decoded (falling back to the raw
 * header), path separators and control characters replaced, leading dots dropped, capped.
 */
export function cleanFilename(raw: string | null | undefined): string {
  let name = raw ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not valid percent-encoding: keep the header as it came.
  }
  name = name
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  if (name.length > CONTROLLER_FILENAME_MAX_CHARS) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, CONTROLLER_FILENAME_MAX_CHARS - extension.length) + extension;
  }
  return name || "file";
}

/** Names unique within one message: a repeated one gets -2, -3 … before its extension. */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    let counter = 2;
    while (used.has(`${stem}-${counter}${extension}`)) counter++;
    const unique = `${stem}-${counter}${extension}`;
    used.add(unique);
    return unique;
  });
}

export class ControllerFileStore {
  private readonly files = new Map<string, StagedFile>();
  private readonly now: () => number;
  private readonly prepare: (data: Buffer, mime: string) => Buffer;

  constructor(private readonly options: ControllerFileStoreOptions) {
    this.now = options.now ?? (() => Date.now());
    this.prepare = options.prepare ?? ((data) => data);
    rmSync(options.dir, { recursive: true, force: true });
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  }

  /** Stage an upload for P in a scope. 400 empty_file, 413 too_large / quota. */
  stage(person: string, scope: string, upload: { name: string | null | undefined; mime: string | null | undefined; data: Buffer }): ControllerFile {
    this.sweep();
    const bytes = upload.data.length;
    if (bytes === 0) throw new ControllerError(400, "empty_file", "The file is empty.");
    if (bytes > CONTROLLER_FILE_MAX_BYTES) throw new ControllerError(413, "too_large", "The file is larger than 25 MB.");
    const pending = [...this.files.values()].filter((file) => file.person === person);
    const pendingBytes = pending.reduce((total, file) => total + file.storedBytes, 0);
    if (pending.length >= CONTROLLER_FILES_MAX_PENDING || pendingBytes + bytes > CONTROLLER_FILES_MAX_PENDING_BYTES) {
      throw new ControllerError(413, "quota", "Too many files are waiting to be sent.");
    }
    const mime = cleanMime(upload.mime);
    const stored = this.prepare(upload.data, mime);
    const id = randomBytes(12).toString("hex");
    const path = join(this.options.dir, id);
    writeFileSync(path, stored, { mode: 0o600 });
    const file: StagedFile = {
      id,
      name: cleanFilename(upload.name),
      bytes,
      mime,
      person,
      scope,
      path,
      storedBytes: stored.length,
      createdAt: this.now(),
    };
    this.files.set(id, file);
    return { id: file.id, name: file.name, bytes: file.bytes, mime: file.mime };
  }

  /**
   * Take P's staged files for a message in the scope, as attachments, in the order given.
   * All or nothing: any id that isn't P's in this scope (or expired, or sent) is 400 unknown_file
   * and nothing is taken.
   */
  take(person: string, scope: string, ids: string[]): ChannelAttachment[] {
    this.sweep();
    const staged = ids.map((id) => {
      const file = this.files.get(id);
      if (!file || file.person !== person || file.scope !== scope) {
        throw new ControllerError(400, "unknown_file", "A file isn't uploaded to this session (or was already sent).");
      }
      return file;
    });
    if (new Set(ids).size !== ids.length) throw new ControllerError(400, "unknown_file", "The same file is listed twice.");
    const names = uniqueNames(staged.map((file) => file.name));
    const attachments = staged.map((file, index) => ({
      filename: names[index],
      contentType: file.mime,
      data: readFileSync(file.path).toString("base64"),
      size: file.storedBytes,
    }));
    for (const file of staged) this.discard(file);
    return attachments;
  }

  /** How many files P has waiting (tests, diagnostics). */
  pendingCount(person: string): number {
    return [...this.files.values()].filter((file) => file.person === person).length;
  }

  /** Drop files older than the TTL. */
  sweep(): void {
    const cutoff = this.now() - CONTROLLER_FILE_TTL_MS;
    for (const file of this.files.values()) {
      if (file.createdAt <= cutoff) this.discard(file);
    }
  }

  private discard(file: StagedFile): void {
    this.files.delete(file.id);
    rmSync(file.path, { force: true });
  }
}

/** A plain `type/subtype` (parameters dropped), or application/octet-stream. */
function cleanMime(raw: string | null | undefined): string {
  const mime = (raw ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : "application/octet-stream";
}
