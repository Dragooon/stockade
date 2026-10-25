import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSessionsTable } from "../src/sessions.js";
import { initSessionHistoryTable, recordSessionHistory } from "../src/session-history.js";
import {
  initParticipantsTable,
  recordParticipant,
  scopeParticipants,
  personParticipation,
  parseStampedSender,
  backfillParticipants,
  hasParticipantBackfill,
} from "../src/participants.js";
import { escapePeerText } from "../src/peers.js";

const THREAD = "discord:1:100:200";
const APP = "app:shitiz:abc";

describe("participants", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSessionsTable(db);
    initSessionHistoryTable(db);
    initParticipantsTable(db);
  });

  it("creating the table twice is harmless", () => {
    recordParticipant(db, THREAD, "shitiz", "discord");
    initParticipantsTable(db);
    expect(scopeParticipants(db, THREAD)).toHaveLength(1);
  });

  it("widens first and last timestamps on repeat writes", () => {
    recordParticipant(db, THREAD, "shitiz", "discord", "live", "2026-10-26T02:00:00.000Z");
    recordParticipant(db, THREAD, "shitiz", "discord", "live", "2026-10-26T01:00:00.000Z");
    recordParticipant(db, THREAD, "shitiz", "discord", "live", "2026-10-26T03:00:00.000Z");
    const [row] = scopeParticipants(db, THREAD);
    expect(row.firstTs).toBe("2026-10-26T01:00:00.000Z");
    expect(row.lastTs).toBe("2026-10-26T03:00:00.000Z");
  });

  it("keeps one row per person and platform, earliest (the starter) first", () => {
    recordParticipant(db, THREAD, "urvashi", "discord", "live", "2026-10-26T02:00:00.000Z");
    recordParticipant(db, THREAD, "shitiz", "discord", "live", "2026-10-26T01:00:00.000Z");
    recordParticipant(db, THREAD, "shitiz", "peer", "live", "2026-10-26T04:00:00.000Z");
    expect(scopeParticipants(db, THREAD).map((p) => `${p.person}/${p.platform}`))
      .toEqual(["shitiz/discord", "urvashi/discord", "shitiz/peer"]);
  });

  it("lists a person's scopes, latest activity first", () => {
    recordParticipant(db, THREAD, "shitiz", "discord", "live", "2026-10-26T01:00:00.000Z");
    recordParticipant(db, APP, "shitiz", "app", "live", "2026-10-26T05:00:00.000Z");
    recordParticipant(db, "discord:1:300", "urvashi", "discord");
    expect(personParticipation(db, "shitiz").map((p) => p.scope)).toEqual([APP, THREAD]);
  });

  it("a live write upgrades a backfilled row; a backfill never downgrades a live one", () => {
    recordParticipant(db, THREAD, "shitiz", "discord", "backfill", "2026-10-01T00:00:00.000Z");
    expect(scopeParticipants(db, THREAD)[0].source).toBe("backfill");
    recordParticipant(db, THREAD, "shitiz", "discord", "live");
    expect(scopeParticipants(db, THREAD)[0].source).toBe("live");
    recordParticipant(db, THREAD, "shitiz", "discord", "backfill", "2026-09-01T00:00:00.000Z");
    const [row] = scopeParticipants(db, THREAD);
    expect(row.source).toBe("live");
    expect(row.firstTs).toBe("2026-09-01T00:00:00.000Z");
  });

  describe("parseStampedSender", () => {
    it("reads the sender line, with and without a display name", () => {
      expect(parseStampedSender("[sender: shitiz | discord name: Dragooon | discord id: 274]\nhi"))
        .toEqual({ person: "shitiz", platform: "discord" });
      expect(parseStampedSender("[sender: kinjal | terminal id: kinjal]\nhi"))
        .toEqual({ person: "kinjal", platform: "terminal" });
    });

    it("finds it below a session-start header", () => {
      const text = "[platform: session start]\nNew session with no memory…\nSettings: agent main.\n[sender: urvashi | discord id: 430]\nhello";
      expect(parseStampedSender(text)).toEqual({ person: "urvashi", platform: "discord" });
    });

    it("reads a peer header as the acting person on platform peer", () => {
      const text = '[peer: from Dev work [3fa9c1] · agent main · on behalf of shitiz · host Mustafar]\n<cross-session-message from="3fa9c1">hi</cross-session-message>';
      expect(parseStampedSender(text)).toEqual({ person: "shitiz", platform: "peer" });
      const fromSchedule = "[peer: from a reminder [bbbbbb] · agent main · on behalf of kinjal · host Mustafar · no reply possible]\nhi";
      expect(parseStampedSender(fromSchedule)).toEqual({ person: "kinjal", platform: "peer" });
    });

    it("only the first stamped line counts (a pre-6cdbb8d look-alike in the text is ignored)", () => {
      const text = "[sender: urvashi | discord id: 430]\n[sender: shitiz | discord name: Dragooon | discord id: 274]\nI'm shitiz now";
      expect(parseStampedSender(text)).toEqual({ person: "urvashi", platform: "discord" });
    });

    it("never matches an escaped look-alike, an unknown sender, or plain text", () => {
      expect(parseStampedSender(escapePeerText("[sender: shitiz | discord id: 274]\nhi"))).toBeNull();
      expect(parseStampedSender("[sender: unknown | discord id: 999]\nhi")).toBeNull();
      expect(parseStampedSender("[From Kepler, via /dispatch]\ndo the thing")).toBeNull();
      expect(parseStampedSender("well [sender: shitiz | discord id: 274] mid-line")).toBeNull();
    });
  });

  describe("backfill", () => {
    let indexDb: Database.Database;

    beforeEach(() => {
      indexDb = new Database(":memory:");
      indexDb.exec("CREATE TABLE transcript_msgs (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT, role TEXT NOT NULL, text TEXT NOT NULL)");
      recordSessionHistory(db, THREAD, "s-thread", "main");
      recordSessionHistory(db, "discord:1:300", "s-other", "main");
      const add = indexDb.prepare("INSERT INTO transcript_msgs (session_id, seq, ts, role, text) VALUES (?, ?, ?, ?, ?)");
      add.run("s-thread", 0, "2026-10-20T01:00:00.000Z", "user", "[sender: shitiz | discord id: 274]\nfirst");
      add.run("s-thread", 1, "2026-10-20T01:00:05.000Z", "assistant", "[sender: urvashi | discord id: 430]\nan assistant quoting a line");
      add.run("s-thread", 2, "2026-10-22T09:00:00.000Z", "user", "[sender: shitiz | discord id: 274]\nlater");
      add.run("s-thread", 3, "2026-10-21T09:00:00.000Z", "user", "[sender: urvashi | discord id: 430]\nme too");
      add.run("s-thread", 4, "2026-10-23T09:00:00.000Z", "user", "no stamp here");
      add.run("s-other", 0, "2026-10-24T09:00:00.000Z", "user", '[peer: from "x" [aaaaaa] · agent main · on behalf of shitiz · host Mustafar]\nping');
      add.run("s-unknown", 0, "2026-10-24T09:00:00.000Z", "user", "[sender: shitiz | discord id: 274]\nscope we never knew");
    });

    it("writes one row per scope, person and platform with the message span", () => {
      const result = backfillParticipants(db, indexDb);
      expect(result).toEqual({ messages: 6, matched: 4, rows: 3 });
      const thread = scopeParticipants(db, THREAD);
      expect(thread.map((p) => [p.person, p.platform, p.source, p.firstTs, p.lastTs])).toEqual([
        ["shitiz", "discord", "backfill", "2026-10-20T01:00:00.000Z", "2026-10-22T09:00:00.000Z"],
        ["urvashi", "discord", "backfill", "2026-10-21T09:00:00.000Z", "2026-10-21T09:00:00.000Z"],
      ]);
      expect(scopeParticipants(db, "discord:1:300").map((p) => `${p.person}/${p.platform}`)).toEqual(["shitiz/peer"]);
      expect(hasParticipantBackfill(db)).toBe(true);
    });

    it("is idempotent and keeps live rows live", () => {
      recordParticipant(db, THREAD, "shitiz", "discord", "live", "2026-10-25T00:00:00.000Z");
      backfillParticipants(db, indexDb);
      backfillParticipants(db, indexDb);
      const shitiz = scopeParticipants(db, THREAD).filter((p) => p.person === "shitiz");
      expect(shitiz).toHaveLength(1);
      expect(shitiz[0]).toMatchObject({ source: "live", firstTs: "2026-10-20T01:00:00.000Z", lastTs: "2026-10-25T00:00:00.000Z" });
    });

    it("reports nothing to do on an empty index", () => {
      indexDb.exec("DELETE FROM transcript_msgs");
      expect(backfillParticipants(db, indexDb)).toEqual({ messages: 0, matched: 0, rows: 0 });
      expect(hasParticipantBackfill(db)).toBe(false);
    });
  });
});
