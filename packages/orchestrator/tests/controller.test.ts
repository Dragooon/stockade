import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { initParticipantsTable, recordParticipant, personParticipation, scopeParticipants } from "../src/participants.js";
import { initScopeBindingsTable, bindScope, getScopeBinding, scopesBoundTo } from "../src/scope-bindings.js";
import { ControllerService, controllerSessionId, type ControllerDeps, type ControllerEvent } from "../src/controller.js";
import type { TranscriptRecord } from "../src/controller-transcript.js";
import { mountControllerRoutes } from "../src/api/controller-routes.js";
import { ControllerApprovals } from "../src/controller-approvals.js";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const DISCORD = "discord:g:general";
const HIDDEN = "discord:g:private";
const OTHERS = "discord:g:others";
const APP = "app:shitiz:a1";
const OTHER_APP = "app:urvashi:b2";
const PEER = "peer:p1";
const KEPLER_PEER = "peer:k1";

/** A controller for shitiz over a real participation/bindings DB, with fakes for the rest. */
function world(overrides: Partial<ControllerDeps> = {}) {
  const db = new Database(":memory:");
  initParticipantsTable(db);
  initScopeBindingsTable(db);
  const live = new Map<string, "busy" | "idle">();
  const sudo = new Set<string>();
  const turnEnded = new Map<string, number>();
  const transcripts = new Map<string, TranscriptRecord[]>();
  const claudeIds = new Map<string, string>([[DISCORD, "claude-1"]]);
  const sent: Array<{ scope: string; text: string }> = [];
  let created = 0;
  const service = new ControllerService({
    person: "shitiz",
    peerSessions: true,
    participation: (person) => personParticipation(db, person),
    participants: (scope) => scopeParticipants(db, scope),
    boundScopes: (person) => scopesBoundTo(db, person),
    binding: (scope) => getScopeBinding(db, scope),
    canView: async (scope) => scope !== HIDDEN,
    agentForScope: (scope) => getScopeBinding(db, scope)?.agentId ?? "main",
    describe: async (scope) => `label of ${scope}`,
    status: (scope) => live.get(scope) ?? "closed",
    lastTurnEnded: (scope) => turnEnded.get(scope) ?? null,
    inSudo: (scope) => sudo.has(scope),
    claudeSessionId: (scope) => claudeIds.get(scope) ?? null,
    agents: () => [{ id: "main", name: "Madge" }],
    now: () => NOW,
    transcript: async (scope) => transcripts.get(scope) ?? [],
    busyScopes: () => [...live].filter(([, state]) => state === "busy").map(([scope]) => scope),
    send: (scope, text) => {
      sent.push({ scope, text });
      return live.get(scope) === "busy" ? "queued" : "delivered";
    },
    createAppScope: (agentId) => {
      const scope = `app:shitiz:new${++created}`;
      bindScope(db, { scope, agentId, person: "shitiz", origin: "app" });
      return scope;
    },
    followMs: 10,
    ...overrides,
  });
  return { db, service, live, sudo, turnEnded, transcripts, claudeIds, sent };
}

describe("ControllerService: what the app lists", () => {
  let w: ReturnType<typeof world>;

  beforeEach(() => {
    w = world();
    const { db } = w;
    recordParticipant(db, DISCORD, "shitiz", "discord", "live", "2026-10-26T10:00:00.000Z");
    recordParticipant(db, DISCORD, "urvashi", "discord", "live", "2026-10-26T09:00:00.000Z");
    recordParticipant(db, HIDDEN, "shitiz", "discord", "live", "2026-10-26T10:00:00.000Z");
    recordParticipant(db, OTHERS, "urvashi", "discord", "live", "2026-10-26T10:00:00.000Z");
    recordParticipant(db, "discord:g:general#sched:t1", "shitiz", "discord", "live", "2026-10-26T10:00:00.000Z");
    recordParticipant(db, "api:main:0b7f6a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b", "shitiz", "api", "live", "2026-10-26T10:00:00.000Z");
    bindScope(db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" }, "2026-10-26T11:00:00.000Z");
    bindScope(db, { scope: OTHER_APP, agentId: "main", person: "urvashi", origin: "app" }, "2026-10-26T11:00:00.000Z");
  });

  it("lists P's viewable sessions and own app scopes, never hidden, others', scheduler or throwaway api scopes", async () => {
    const scopes = (await w.service.sessions()).map((s) => s.scope);
    expect(scopes.sort()).toEqual([APP, DISCORD].sort());
  });

  it("drops a Discord scope P can no longer view", async () => {
    const service = world({ canView: async () => false }).service;
    expect(await service.sessions()).toEqual([]);
  });

  it("describes a Discord session as read-only with its participants and starter", async () => {
    w.live.set(DISCORD, "idle");
    w.sudo.add(DISCORD);
    const session = (await w.service.sessions()).find((s) => s.scope === DISCORD)!;
    expect(session).toMatchObject({
      id: controllerSessionId(DISCORD),
      ref: controllerSessionId(DISCORD).slice(0, 6),
      label: `label of ${DISCORD}`,
      agentId: "main",
      status: "idle",
      lastActive: Date.parse("2026-10-26T10:00:00.000Z"), // idle: P's latest message, not "now"
      sudo: true,
      claudeSessionId: "claude-1",
      origin: "discord",
      startedBy: { kind: "person", name: "urvashi" },
      participants: [{ name: "urvashi", platform: "discord" }, { name: "shitiz", platform: "discord" }],
      writable: false,
      readOnlyReason: "discord",
    });
    expect(session.id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("an app scope is writable, started by its person, last active at its newest timestamp", async () => {
    const session = (await w.service.sessions()).find((s) => s.scope === APP)!;
    expect(session).toMatchObject({
      origin: "app", writable: true, readOnlyReason: null, status: "closed",
      startedBy: { kind: "person", name: "shitiz" },
      lastActive: Date.parse("2026-10-26T11:00:00.000Z"),
    });
  });

  it("lastUserMessageAt is the latest message a person sent, never an agent acting for them", async () => {
    let sessions = await w.service.sessions();
    expect(sessions.find((s) => s.scope === DISCORD)?.lastUserMessageAt).toBe("2026-10-26T10:00:00.000Z");
    expect(sessions.find((s) => s.scope === APP)?.lastUserMessageAt).toBeNull(); // bound, nobody wrote yet
    recordParticipant(w.db, APP, "shitiz", "app", "live", "2026-10-26T11:30:00.000Z");
    recordParticipant(w.db, APP, "shitiz", "peer", "live", "2026-10-26T11:40:00.000Z");
    recordParticipant(w.db, APP, "shitiz", "api", "live", "2026-10-26T11:50:00.000Z");
    sessions = await w.service.sessions();
    const app = sessions.find((s) => s.scope === APP)!;
    expect(app.lastUserMessageAt).toBe("2026-10-26T11:30:00.000Z");
    expect(app.lastActive).toBe(Date.parse("2026-10-26T11:50:00.000Z")); // lastActive still counts agent activity
  });

  it("sorts by latest activity", async () => {
    w.live.set(DISCORD, "busy");
    expect((await w.service.sessions()).map((s) => s.scope)).toEqual([DISCORD, APP]);
  });

  it("finds a listed session by id and nothing else", async () => {
    expect((await w.service.find(controllerSessionId(APP)))?.scope).toBe(APP);
    expect(await w.service.find(controllerSessionId(OTHER_APP))).toBeNull();
    expect(await w.service.find(controllerSessionId(HIDDEN))).toBeNull();
  });
});

describe("ControllerService: cross-agent sessions acting for P", () => {
  function crossWorld(peerSessions: boolean) {
    const w = world({ peerSessions });
    recordParticipant(w.db, OTHERS, "shitiz", "peer", "live", "2026-10-26T10:00:00.000Z");
    recordParticipant(w.db, "api:kepler", "shitiz", "api", "live", "2026-10-26T10:00:00.000Z");
    bindScope(w.db, { scope: PEER, agentId: "search", person: "shitiz", origin: "peer" });
    bindScope(w.db, { scope: KEPLER_PEER, agentId: "main", person: "shitiz", origin: "kepler" });
    return w;
  }

  it("lists peer inserts, peer:/Kepler scopes and api:kepler when peer_sessions is on", async () => {
    const sessions = await crossWorld(true).service.sessions();
    const byScope = new Map(sessions.map((s) => [s.scope, s]));
    expect([...byScope.keys()].sort()).toEqual(["api:kepler", KEPLER_PEER, OTHERS, PEER].sort());
    expect(byScope.get(KEPLER_PEER)).toMatchObject({ origin: "peer", writable: true, startedBy: { kind: "agent", name: "Kepler" } });
    expect(byScope.get(PEER)).toMatchObject({ origin: "peer", writable: true, agentId: "search" });
    expect(byScope.get("api:kepler")).toMatchObject({ origin: "peer", writable: false, readOnlyReason: "agent", startedBy: { kind: "agent", name: "Kepler" } });
    expect(byScope.get(OTHERS)).toMatchObject({ origin: "discord", writable: false, readOnlyReason: "discord" });
  });

  it("lists none of them when peer_sessions is off", async () => {
    expect(await crossWorld(false).service.sessions()).toEqual([]);
  });

  it("a scope P has also written in is P's own, listed even with peer_sessions off", async () => {
    const w = crossWorld(false);
    recordParticipant(w.db, OTHERS, "shitiz", "discord");
    recordParticipant(w.db, PEER, "shitiz", "app");
    expect((await w.service.sessions()).map((s) => s.scope).sort()).toEqual([OTHERS, PEER].sort());
  });
});

describe("ControllerService: events", () => {
  it("tells subscribers about a visible scope's change, and nothing about others", async () => {
    const w = world();
    recordParticipant(w.db, DISCORD, "shitiz", "discord");
    const events: ControllerEvent[] = [];
    const unsubscribe = w.service.subscribe((event) => events.push(event));
    w.live.set(DISCORD, "busy");
    await w.service.notify(DISCORD);
    await w.service.notify(OTHERS);
    await w.service.notify(HIDDEN);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "session", session: { scope: DISCORD, status: "busy" } });
    unsubscribe();
    await w.service.notify(DISCORD);
    expect(events).toHaveLength(1);
  });

  it("emits the latest state last when two notifies race (the first one's describe resolves last)", async () => {
    const pending: Array<() => void> = [];
    const w = world({ describe: (scope) => new Promise((resolve) => pending.push(() => resolve(`label of ${scope}`))) });
    recordParticipant(w.db, DISCORD, "shitiz", "discord");
    const events: ControllerEvent[] = [];
    w.service.subscribe((event) => events.push(event));
    w.live.set(DISCORD, "busy");
    const busyNotify = w.service.notify(DISCORD);
    await new Promise((r) => setTimeout(r, 0));
    w.live.set(DISCORD, "idle");
    const idleNotify = w.service.notify(DISCORD);
    await new Promise((r) => setTimeout(r, 0));
    expect(pending).toHaveLength(2);
    pending[1](); // the idle notify's describe resolves first …
    await idleNotify;
    pending[0](); // … the busy one's last
    await busyNotify;
    expect(events.map((e) => e.session.status)).toEqual(["idle", "idle"]);
  });
});

describe("ControllerService: lastActive", () => {
  const at = (iso: string) => Date.parse(iso);

  it("is now while busy, when the last turn ended once idle or closed, and the stored times after a restart", async () => {
    const w = world();
    recordParticipant(w.db, DISCORD, "shitiz", "discord", "live", "2026-10-26T10:00:00.000Z");
    const lastActive = async () => (await w.service.sessions())[0].lastActive;

    w.live.set(DISCORD, "busy");
    expect(await lastActive()).toBe(NOW);
    w.live.set(DISCORD, "idle");
    expect(await lastActive()).toBe(at("2026-10-26T10:00:00.000Z")); // no turn ended since startup
    w.turnEnded.set(DISCORD, at("2026-10-26T11:30:00.000Z"));
    expect(await lastActive()).toBe(at("2026-10-26T11:30:00.000Z"));
    w.live.delete(DISCORD);
    expect(await lastActive()).toBe(at("2026-10-26T11:30:00.000Z"));
  });

  it("sorts an idle session below one that ran more recently", async () => {
    const w = world();
    recordParticipant(w.db, DISCORD, "shitiz", "discord", "live", "2026-10-26T09:00:00.000Z");
    recordParticipant(w.db, OTHERS, "shitiz", "discord", "live", "2026-10-26T11:00:00.000Z");
    w.live.set(DISCORD, "idle");
    expect((await w.service.sessions()).map((s) => s.scope)).toEqual([OTHERS, DISCORD]);
  });
});

describe("controller routes", () => {
  const TOKEN = "t".repeat(40);

  function server(services = new Map<string, ControllerService>()) {
    const app = new Hono();
    mountControllerRoutes(app, { services, controller: { id: "mustafar", name: "Mustafar" } });
    return app;
  }
  const get = (app: Hono, path: string, token?: string) =>
    app.request(path, token ? { headers: { authorization: `Bearer ${token}` } } : {});

  it("is 404 everywhere without configured tokens", async () => {
    const response = await get(server(), "/controller/sessions", TOKEN);
    expect(response.status).toBe(404);
  });

  it("refuses a missing or wrong token", async () => {
    const app = server(new Map([[TOKEN, world().service]]));
    expect((await get(app, "/controller/sessions")).status).toBe(401);
    expect((await get(app, "/controller/sessions", "x".repeat(40))).status).toBe(401);
    expect((await get(app, "/controller/sessions", TOKEN.slice(1))).status).toBe(401);
  });

  it("serves info, sessions, one session, agents, and unsupported for the rest", async () => {
    const w = world();
    recordParticipant(w.db, DISCORD, "shitiz", "discord");
    const app = server(new Map([[TOKEN, w.service]]));

    expect(await (await get(app, "/controller/info", TOKEN)).json()).toEqual({
      controller: { id: "mustafar", name: "Mustafar", kind: "stockade", capabilities: ["list", "transcript", "send", "new_session", "decide", "questions"] },
      person: "shitiz",
    });
    const sessions = await (await get(app, "/controller/sessions", TOKEN)).json() as Array<{ id: string; scope: string }>;
    expect(sessions.map((s) => s.scope)).toEqual([DISCORD]);
    const one = await get(app, `/controller/sessions/${sessions[0].id}`, TOKEN);
    expect(((await one.json()) as { scope: string }).scope).toBe(DISCORD);
    expect((await get(app, "/controller/sessions/000000000000", TOKEN)).status).toBe(404);
    expect(await (await get(app, "/controller/agents", TOKEN)).json()).toEqual([{ id: "main", name: "Madge" }]);

    const unsupported = await get(app, "/controller/approvals", TOKEN);
    expect(unsupported.status).toBe(404);
    expect(await unsupported.json()).toEqual({ error: "unsupported" });
  });

  it("each token sees its own person's sessions", async () => {
    const shitiz = world();
    const urvashi = world({ person: "urvashi" });
    bindScope(shitiz.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    bindScope(urvashi.db, { scope: OTHER_APP, agentId: "main", person: "urvashi", origin: "app" });
    const other = "u".repeat(40);
    const app = server(new Map([[TOKEN, shitiz.service], [other, urvashi.service]]));
    const scopesFor = async (token: string) =>
      ((await (await get(app, "/controller/sessions", token)).json()) as Array<{ scope: string }>).map((s) => s.scope);
    expect(await scopesFor(TOKEN)).toEqual([APP]);
    expect(await scopesFor(other)).toEqual([OTHER_APP]);
  });

  it("streams session events over SSE", async () => {
    const w = world();
    recordParticipant(w.db, DISCORD, "shitiz", "discord");
    const app = server(new Map([[TOKEN, w.service]]));
    const controller = new AbortController();
    const response = await app.request("/controller/events", {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) text += decoder.decode((await reader.read()).value);
    };
    await readUntil(": connected");
    w.live.set(DISCORD, "busy");
    await w.service.notify(DISCORD);
    await readUntil("\n\n" + "event: session");
    await readUntil('"status":"busy"');
    expect(text).toContain(`"scope":"${DISCORD}"`);
    controller.abort();
    await reader.cancel().catch(() => {});
  });
});

const user = (uuid: string, content: unknown, extra: TranscriptRecord = {}): TranscriptRecord =>
  ({ type: "user", uuid, sessionId: "claude-1", message: { role: "user", content }, ...extra });
const assistant = (uuid: string, content: unknown[]): TranscriptRecord =>
  ({ type: "assistant", uuid, sessionId: "claude-1", message: { role: "assistant", id: `m-${uuid}`, model: "opus", content } });

describe("ControllerService: transcripts (§5)", () => {
  const records: TranscriptRecord[] = [
    { type: "summary", summary: "no uuid" },
    user("u1", "[sender: shitiz]\nhello"),
    assistant("a1", [{ type: "thinking", thinking: "secret" }, { type: "text", text: "hi" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat ~/.ssh/id" } }]),
    user("u2", [{ type: "tool_result", tool_use_id: "t1", content: "PRIVATE KEY" }]),
    user("u3", "<command-name>/clear</command-name>"),
    user("u4", "meta", { isMeta: true }),
    assistant("s1", [{ type: "text", text: "sidechain" }]),
    assistant("a2", [{ type: "text", text: "done" }]),
  ];
  records[6].isSidechain = true;

  it("serves raw records, with ids for records without a uuid, when only P is in the session", async () => {
    const w = world();
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    recordParticipant(w.db, APP, "shitiz", "app");
    w.transcripts.set(APP, records);
    const served = await w.service.transcript(controllerSessionId(APP));
    expect(served).toHaveLength(records.length);
    expect(served[0]).toEqual({ type: "summary", summary: "no uuid", id: "line-0" });
    expect(served[3]).toBe(records[3]);
  });

  it("serves the text-only projection when someone else is in the session", async () => {
    const w = world();
    recordParticipant(w.db, DISCORD, "shitiz", "discord");
    recordParticipant(w.db, DISCORD, "urvashi", "discord");
    w.transcripts.set(DISCORD, records);
    const served = await w.service.transcript(controllerSessionId(DISCORD));
    expect(served.map((r) => r.uuid)).toEqual(["u1", "a1", "a2"]);
    expect(served[1]).toEqual({
      type: "assistant", uuid: "a1", sessionId: "claude-1",
      message: { role: "assistant", id: "m-a1", model: "opus", content: [{ type: "text", text: "hi" }] },
    });
    expect(JSON.stringify(served)).not.toMatch(/PRIVATE KEY|secret|ssh|sidechain/);
  });

  it("counts a principal working for P as P (raw), but not one working for someone else", async () => {
    const PEER = "peer:00000000000a";
    const forShitiz = world({ principalFor: (name) => (name === "kepler" ? "shitiz" : null) });
    bindScope(forShitiz.db, { scope: PEER, agentId: "main", person: "shitiz", origin: "kepler" });
    recordParticipant(forShitiz.db, PEER, "kepler", "api");
    recordParticipant(forShitiz.db, PEER, "shitiz", "app");
    forShitiz.transcripts.set(PEER, records);
    expect(await forShitiz.service.transcript(controllerSessionId(PEER))).toHaveLength(records.length);

    const forOther = world({ principalFor: (name) => (name === "kepler" ? "urvashi" : null) });
    bindScope(forOther.db, { scope: PEER, agentId: "main", person: "shitiz", origin: "kepler" });
    recordParticipant(forOther.db, PEER, "kepler", "api");
    forOther.transcripts.set(PEER, records);
    expect((await forOther.service.transcript(controllerSessionId(PEER))).map((r) => r.uuid)).toEqual(["u1", "a1", "a2"]);
  });

  it("pages by after and limit, from the start when after is unknown", async () => {
    const w = world();
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    w.transcripts.set(APP, records);
    const id = controllerSessionId(APP);
    expect((await w.service.transcript(id, { after: "a1", limit: 2 })).map((r) => r.uuid)).toEqual(["u2", "u3"]);
    expect((await w.service.transcript(id, { after: "line-0", limit: 1 }))[0].uuid).toBe("u1");
    expect(await w.service.transcript(id, { after: "a2" })).toEqual([]);
    expect(await w.service.transcript(id, { after: "gone", limit: 1 })).toEqual([records[0] && { ...records[0], id: "line-0" }]);
    expect(await w.service.transcript(id, { limit: 0 })).toHaveLength(1);
  });

  it("is 404 for a session P can't see", async () => {
    const w = world();
    bindScope(w.db, { scope: OTHER_APP, agentId: "main", person: "urvashi", origin: "app" });
    await expect(w.service.transcript(controllerSessionId(OTHER_APP))).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("ControllerService: writing (§4, §7)", () => {
  it("sends into an app scope, reporting queued while someone else's turn runs", async () => {
    const w = world();
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    expect(await w.service.send(controllerSessionId(APP), "hello")).toEqual({ delivered: true, queued: false });
    w.live.set(APP, "busy");
    expect(await w.service.send(controllerSessionId(APP), "again")).toEqual({ delivered: true, queued: true });
    expect(w.sent).toEqual([{ scope: APP, text: "hello" }, { scope: APP, text: "again" }]);
  });

  it("refuses Discord scopes as read_only, unknown ids as not_found, and empty text", async () => {
    const w = world();
    recordParticipant(w.db, DISCORD, "shitiz", "discord");
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    await expect(w.service.send(controllerSessionId(DISCORD), "hi")).rejects.toMatchObject({ status: 403, code: "read_only" });
    await expect(w.service.send("000000000000", "hi")).rejects.toMatchObject({ status: 404 });
    await expect(w.service.send(controllerSessionId(APP), "  ")).rejects.toMatchObject({ status: 400, code: "text_required" });
    await expect(w.service.send(controllerSessionId(APP), 7)).rejects.toMatchObject({ status: 400 });
    expect(w.sent).toEqual([]);
  });

  it("creates an app scope bound to P and the agent, sends the first message, returns its row", async () => {
    const w = world();
    const session = await w.service.createSession({ agentId: "main", text: "Check the build" });
    expect(session).toMatchObject({ scope: "app:shitiz:new1", agentId: "main", origin: "app", writable: true });
    expect(getScopeBinding(w.db, "app:shitiz:new1")).toMatchObject({ person: "shitiz", agentId: "main", origin: "app" });
    expect(w.sent).toEqual([{ scope: "app:shitiz:new1", text: "Check the build" }]);
    expect((await w.service.sessions()).map((s) => s.scope)).toContain("app:shitiz:new1");
  });

  it("refuses an agent P can't use, and a missing agent or text, without creating anything", async () => {
    const w = world();
    await expect(w.service.createSession({ agentId: "kleya", text: "hi" })).rejects.toMatchObject({ status: 403, code: "agent_forbidden" });
    await expect(w.service.createSession({ text: "hi" })).rejects.toMatchObject({ status: 400, code: "agent_required" });
    await expect(w.service.createSession({ agentId: "main" })).rejects.toMatchObject({ status: 400, code: "text_required" });
    expect(scopesBoundTo(w.db, "shitiz")).toEqual([]);
    expect(w.sent).toEqual([]);
  });
});

describe("ControllerService: live transcript events", () => {
  const transcriptEvents = (events: ControllerEvent[]) =>
    events.filter((e): e is Extract<ControllerEvent, { type: "transcript" }> => e.type === "transcript");

  it("sends records added after the first look, before the session row, and restarts on a new Claude session", async () => {
    const w = world();
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    w.claudeIds.set(APP, "c1");
    w.transcripts.set(APP, [user("u1", "old")]);
    const events: ControllerEvent[] = [];
    w.service.subscribe((event) => events.push(event));
    await w.service.notify(APP); // baseline: u1 was served by GET transcript
    expect(transcriptEvents(events)).toEqual([]);

    w.transcripts.set(APP, [user("u1", "old"), user("u2", "new"), { type: "summary" }]);
    await w.service.notify(APP);
    expect(transcriptEvents(events).map((e) => e.recordId)).toEqual(["u2", "line-2"]);
    expect(transcriptEvents(events)[0]).toMatchObject({ id: controllerSessionId(APP), claudeSessionId: "c1", record: { uuid: "u2" } });
    expect(events.at(-1)?.type).toBe("session");

    w.claudeIds.set(APP, "c2");
    w.transcripts.set(APP, [user("v1", "fresh")]);
    await w.service.notify(APP);
    expect(transcriptEvents(events).at(-1)).toMatchObject({ claudeSessionId: "c2", recordId: "v1" });
  });

  it("sends a new session's first records when it had no Claude session at the first look", async () => {
    const w = world();
    const events: ControllerEvent[] = [];
    w.service.subscribe((event) => events.push(event));
    const session = await w.service.createSession({ agentId: "main", text: "hi" });
    await w.service.notify(session.scope); // turn starts: no Claude session yet
    w.claudeIds.set(session.scope, "c1");
    w.transcripts.set(session.scope, [user("u1", "hi"), assistant("a1", [{ type: "text", text: "hello" }])]);
    await w.service.notify(session.scope);
    expect(transcriptEvents(events).map((e) => e.recordId)).toEqual(["u1", "a1"]);
  });

  it("polls busy sessions while someone is subscribed, and stops when they leave", async () => {
    const w = world();
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    w.claudeIds.set(APP, "c1");
    w.live.set(APP, "busy");
    const events: ControllerEvent[] = [];
    const unsubscribe = w.service.subscribe((event) => events.push(event));
    await new Promise((r) => setTimeout(r, 30));
    w.transcripts.set(APP, [user("u1", "streamed")]);
    await new Promise((r) => setTimeout(r, 40));
    expect(transcriptEvents(events).map((e) => e.recordId)).toEqual(["u1"]);
    unsubscribe();
    w.transcripts.set(APP, [user("u1", "streamed"), user("u2", "after")]);
    await new Promise((r) => setTimeout(r, 40));
    expect(transcriptEvents(events)).toHaveLength(1);
  });

  it("starts counting afresh when the form changes (a second person joins), never repeating or skipping by a mismatched count", async () => {
    const w = world();
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    recordParticipant(w.db, APP, "shitiz", "app");
    w.claudeIds.set(APP, "c1");
    const events: ControllerEvent[] = [];
    w.service.subscribe((event) => events.push(event));
    const records: TranscriptRecord[] = [
      { type: "summary", summary: "no uuid" },
      user("u1", "hello"),
      assistant("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      user("u2", [{ type: "tool_result", tool_use_id: "t1", content: "out" }]),
      assistant("a2", [{ type: "text", text: "done" }]),
    ];
    w.transcripts.set(APP, records);
    await w.service.notify(APP); // first sight: raw, 5 records
    recordParticipant(w.db, APP, "urvashi", "discord");
    w.transcripts.set(APP, [...records, assistant("a9", [{ type: "text", text: "after" }])]);
    await w.service.notify(APP); // projected now (3 records): a raw count of 5 would skip a9 and a10
    w.transcripts.set(APP, [...records, assistant("a9", [{ type: "text", text: "after" }]), assistant("a10", [{ type: "text", text: "next" }])]);
    await w.service.notify(APP);
    expect(transcriptEvents(events).map((e) => e.recordId)).toEqual(["a10"]);
  });

  it("projects live records too when the session isn't only P's, and skips scopes P can't see", async () => {
    const w = world();
    recordParticipant(w.db, DISCORD, "shitiz", "discord");
    recordParticipant(w.db, DISCORD, "urvashi", "discord");
    w.claudeIds.set(HIDDEN, "h1");
    const events: ControllerEvent[] = [];
    w.service.subscribe((event) => events.push(event));
    await w.service.notify(DISCORD);
    await w.service.notify(HIDDEN);
    w.transcripts.set(DISCORD, [user("u2", [{ type: "tool_result", content: "PRIVATE" }]), assistant("a3", [{ type: "text", text: "ok" }])]);
    w.transcripts.set(HIDDEN, [user("x1", "hidden")]);
    await w.service.notify(DISCORD);
    await w.service.notify(HIDDEN);
    expect(transcriptEvents(events).map((e) => e.recordId)).toEqual(["a3"]);
  });
});

describe("controller routes: d3b-4", () => {
  const TOKEN = "t".repeat(40);
  const app = (service: ControllerService) => {
    const hono = new Hono();
    mountControllerRoutes(hono, { services: new Map([[TOKEN, service]]), controller: { id: "mustafar", name: "Mustafar" } });
    return hono;
  };
  const call = (hono: Hono, method: string, path: string, body?: unknown) =>
    hono.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });

  it("serves a transcript page, writes messages, creates sessions, and maps refusals to {error}", async () => {
    const w = world();
    recordParticipant(w.db, DISCORD, "shitiz", "discord");
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    w.transcripts.set(APP, [user("u1", "a"), user("u2", "b"), user("u3", "c")]);
    const hono = app(w.service);
    const appId = controllerSessionId(APP);

    const page = await call(hono, "GET", `/controller/sessions/${appId}/transcript?after=u1&limit=1`);
    expect(((await page.json()) as TranscriptRecord[]).map((r) => r.uuid)).toEqual(["u2"]);
    expect((await call(hono, "GET", "/controller/sessions/000000000000/transcript")).status).toBe(404);

    const sent = await call(hono, "POST", `/controller/sessions/${appId}/message`, { text: "hello" });
    expect(await sent.json()).toEqual({ delivered: true, queued: false });
    const readOnly = await call(hono, "POST", `/controller/sessions/${controllerSessionId(DISCORD)}/message`, { text: "hi" });
    expect(readOnly.status).toBe(403);
    expect(await readOnly.json()).toMatchObject({ error: "read_only" });
    expect((await call(hono, "POST", `/controller/sessions/${appId}/message`, "{nope")).status).toBe(400);
    expect((await call(hono, "POST", `/controller/sessions/${appId}/message`, {})).status).toBe(400);

    const created = await call(hono, "POST", "/controller/sessions", { agentId: "main", text: "Check the build" });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ scope: "app:shitiz:new1", origin: "app" });
    const forbidden = await call(hono, "POST", "/controller/sessions", { agentId: "kleya", text: "hi" });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: "agent_forbidden" });
    expect(w.sent.map((s) => s.text)).toEqual(["hello", "Check the build"]);
  });

  it("streams transcript events with the record id as the SSE id", async () => {
    const w = world();
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    w.claudeIds.set(APP, "c1");
    const hono = app(w.service);
    const abort = new AbortController();
    const response = await hono.request("/controller/events", { headers: { authorization: `Bearer ${TOKEN}` }, signal: abort.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) text += decoder.decode((await reader.read()).value);
    };
    await readUntil(": connected");
    await w.service.notify(APP);
    w.transcripts.set(APP, [user("u9", "live")]);
    await w.service.notify(APP);
    await readUntil("event: transcript");
    await readUntil("\n\n");
    expect(text).toMatch(/event: transcript\ndata: \{"type":"transcript"[^\n]*"recordId":"u9"[^\n]*\nid: u9\n/);
    abort.abort();
    await reader.cancel().catch(() => {});
  });
});

describe("controller routes: peer link (D4)", () => {
  const TOKEN = "t".repeat(40);
  const call = (hono: Hono, method: string, path: string, body?: unknown) =>
    hono.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("is 404 unsupported without a link for the token's person", async () => {
    const hono = new Hono();
    mountControllerRoutes(hono, { services: new Map([[TOKEN, world().service]]), controller: { id: "mustafar", name: "Mustafar" }, peerLink: () => null });
    for (const [method, path] of [["GET", "/controller/peer/sessions"], ["POST", "/controller/peer/inbound"], ["POST", "/controller/peer/start"], ["POST", "/controller/peer/notice"]]) {
      const res = await call(hono, method, path, method === "POST" ? {} : undefined);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "unsupported" });
    }
  });

  it("passes the token's person and the body to the link, and needs the token", async () => {
    const seen: Array<[string, string, unknown]> = [];
    const hono = new Hono();
    mountControllerRoutes(hono, {
      services: new Map([[TOKEN, world().service]]),
      controller: { id: "mustafar", name: "Mustafar" },
      peerLink: (person) => ({
        sessions: async () => { seen.push([person, "sessions", null]); return [{ ref: "abcdef" }]; },
        inbound: async (body) => { seen.push([person, "inbound", body]); return { status: "delivered" }; },
        start: async (body) => { seen.push([person, "start", body]); return { status: "awaiting_approval", ref: "123abc" }; },
        notice: async (body) => { seen.push([person, "notice", body]); return { status: "refused", reason: "no" }; },
      }),
    });
    expect(await (await call(hono, "GET", "/controller/peer/sessions")).json()).toEqual([{ ref: "abcdef" }]);
    expect(await (await call(hono, "POST", "/controller/peer/inbound", { to: "x" })).json()).toEqual({ status: "delivered" });
    expect(await (await call(hono, "POST", "/controller/peer/start", { text: "y" })).json()).toEqual({ status: "awaiting_approval", ref: "123abc" });
    expect(await (await call(hono, "POST", "/controller/peer/notice", {})).json()).toEqual({ status: "refused", reason: "no" });
    expect(seen).toEqual([["shitiz", "sessions", null], ["shitiz", "inbound", { to: "x" }], ["shitiz", "start", { text: "y" }], ["shitiz", "notice", {}]]);
    expect((await hono.request("/controller/peer/sessions")).status).toBe(401);
    const bad = await hono.request("/controller/peer/inbound", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{nope" });
    expect(bad.status).toBe(400);
  });
});

describe("controller routes: peer conversations", () => {
  const TOKEN = "t".repeat(40);
  const call = (hono: Hono, method: string, path: string) =>
    hono.request(path, { method, headers: { authorization: `Bearer ${TOKEN}` } });

  it("lists and revokes the token's person's conversations, and advertises the capability", async () => {
    const seen: string[] = [];
    const hono = new Hono();
    mountControllerRoutes(hono, {
      services: new Map([[TOKEN, world().service]]),
      controller: { id: "mustafar", name: "Mustafar" },
      peerConversations: {
        list: async (person) => { seen.push(`list ${person}`); return [{ id: "c1" }]; },
        forget: (person, id) => { seen.push(`forget ${person} ${id}`); return id === "c1"; },
      },
    });
    expect((await (await call(hono, "GET", "/controller/info")).json()).controller.capabilities).toContain("peer_conversations");
    expect(await (await call(hono, "GET", "/controller/peer/conversations")).json()).toEqual([{ id: "c1" }]);
    const gone = await call(hono, "DELETE", "/controller/peer/conversations/c1");
    expect(gone.status).toBe(204);
    expect(await gone.text()).toBe("");
    const missing = await call(hono, "DELETE", "/controller/peer/conversations/c2");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect(seen).toEqual(["list shitiz", "forget shitiz c1", "forget shitiz c2"]);
    expect((await hono.request("/controller/peer/conversations")).status).toBe(401);
  });

  it("without them: 404 unsupported, and no capability", async () => {
    const hono = new Hono();
    mountControllerRoutes(hono, { services: new Map([[TOKEN, world().service]]), controller: { id: "mustafar", name: "Mustafar" } });
    expect((await (await call(hono, "GET", "/controller/info")).json()).controller.capabilities).not.toContain("peer_conversations");
    expect((await call(hono, "GET", "/controller/peer/conversations")).status).toBe(404);
    expect((await call(hono, "DELETE", "/controller/peer/conversations/c1")).status).toBe(404);
  });
});

describe("ControllerService: approvals (§6)", () => {
  function approvalWorld(canApprove = true) {
    let next = 0;
    const approvals = new ControllerApprovals({ newId: () => `ap${++next}`, now: () => NOW });
    const w = world({ approvals, canApprove: () => canApprove });
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    bindScope(w.db, { scope: OTHER_APP, agentId: "main", person: "urvashi", origin: "app" });
    recordParticipant(w.db, DISCORD, "shitiz", "discord");
    const events: ControllerEvent[] = [];
    w.service.subscribe((event) => events.push(event));
    const settled = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
    return { ...w, approvals, events, settled };
  }
  const discordChannel = () => {
    let answer!: (approved: boolean) => void;
    return {
      channel: { askUser: () => new Promise<boolean>((resolve) => { answer = resolve; }), notifyAutoApproved: async () => {} },
      answer: (approved: boolean) => answer(approved),
    };
  };

  it("a peer: scope bound to someone else is neither listed, writable nor decidable, even with P's row in it", async () => {
    const w = approvalWorld();
    const THEIRS = "peer:0123456789ab";
    bindScope(w.db, { scope: THEIRS, agentId: "main", person: "urvashi", origin: "peer" });
    recordParticipant(w.db, THEIRS, "shitiz", "api");
    void w.approvals.ask(THEIRS, "Bash", {});
    await w.settled();
    expect(await w.service.find(controllerSessionId(THEIRS))).toBeNull();
    await expect(w.service.send(controllerSessionId(THEIRS), "hi")).rejects.toMatchObject({ status: 404 });
    await expect(w.service.decide("ap1", { behaviour: "allow" })).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(w.approvals.get("ap1")).not.toBeNull();
    expect(w.events).toEqual([]);
  });

  it("forwards approvals and decisions in P's listed scopes only, in order", async () => {
    const w = approvalWorld();
    const mine = w.approvals.ask(APP, "Bash", { command: "ls" }, { agentId: "main" });
    void w.approvals.ask(OTHER_APP, "Bash", {});
    await w.settled();
    expect(w.events).toEqual([{
      type: "approval",
      id: "ap1",
      sessionId: controllerSessionId(APP),
      scope: APP,
      tool: "Bash",
      input: { command: "ls" },
      receivedAt: new Date(NOW).toISOString(),
      agentId: "main",
      review: null,
      answerIn: null,
    }]);
    expect(await w.service.decide("ap1", { behaviour: "allow" })).toEqual({ decided: true });
    expect(await mine).toBe(true);
    await w.settled();
    expect(w.events.at(-1)).toEqual({ type: "decision", id: "ap1", sessionId: controllerSessionId(APP), scope: APP, behaviour: "allow" });
    expect(w.events.filter((e) => e.scope === OTHER_APP)).toEqual([]);
  });

  it("lists pending approvals for a new stream, without others' or answered ones", async () => {
    const w = approvalWorld();
    void w.approvals.ask(APP, "Bash", {});
    void w.approvals.ask(OTHER_APP, "Bash", {});
    void w.approvals.ask(APP, "Write", {});
    w.approvals.decide("ap3", "deny");
    expect((await w.service.pendingApprovals()).map((e) => e.id)).toEqual(["ap1"]);
  });

  it("shows Discord approvals read-only (403 read_only) and their channel answer as the decision", async () => {
    const w = approvalWorld();
    const { channel, answer } = discordChannel();
    const asked = w.approvals.mirror(channel, DISCORD, "discord").askUser("Bash", {});
    await w.settled();
    expect(w.events[0]).toMatchObject({ type: "approval", id: "ap1", answerIn: "discord" });
    await expect(w.service.decide("ap1", { behaviour: "allow" })).rejects.toMatchObject({ status: 403, code: "read_only" });
    answer(false);
    expect(await asked).toBe(false);
    await w.settled();
    expect(w.events.at(-1)).toMatchObject({ type: "decision", id: "ap1", behaviour: "deny" });
  });

  it("refuses unknown, others', answered, bad behaviours, and a P who can't approve", async () => {
    const w = approvalWorld();
    void w.approvals.ask(OTHER_APP, "Bash", {});
    await expect(w.service.decide("ap1", { behaviour: "allow" })).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(w.service.decide("nope", { behaviour: "allow" })).rejects.toMatchObject({ status: 404 });
    void w.approvals.ask(APP, "Bash", {});
    await expect(w.service.decide("ap2", { behaviour: "maybe" })).rejects.toMatchObject({ status: 400, code: "invalid_behaviour" });
    await expect(w.service.decide("ap2", {})).rejects.toMatchObject({ status: 400 });
    expect(await w.service.decide("ap2", { behavior: "deny" })).toEqual({ decided: true });
    await expect(w.service.decide("ap2", { behaviour: "allow" })).rejects.toMatchObject({ status: 404 });

    const nobody = approvalWorld(false);
    const pending = nobody.approvals.ask(APP, "Bash", {});
    await expect(nobody.service.decide("ap1", { behaviour: "allow" })).rejects.toMatchObject({ status: 403, code: "not_approver" });
    expect(nobody.approvals.list()).toHaveLength(1);
    nobody.approvals.decide("ap1", "deny");
    expect(await pending).toBe(false);
  });

  it("forwards nothing while nobody is subscribed", async () => {
    let next = 0;
    const approvals = new ControllerApprovals({ newId: () => `ap${++next}` });
    const w = world({ approvals });
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    const events: ControllerEvent[] = [];
    void approvals.ask(APP, "Bash", {});
    const unsubscribe = w.service.subscribe((event) => events.push(event));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(events).toEqual([]);
    unsubscribe();
    approvals.decide("ap1", "deny");
  });
});

describe("controller routes: d3b-5", () => {
  const TOKEN = "t".repeat(40);

  it("decides over POST approvals/:id and replays pending approvals when a stream connects", async () => {
    let next = 0;
    const approvals = new ControllerApprovals({ newId: () => `ap${++next}` });
    const w = world({ approvals, canApprove: () => true });
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    const hono = new Hono();
    mountControllerRoutes(hono, { services: new Map([[TOKEN, w.service]]), controller: { id: "mustafar", name: "Mustafar" } });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

    const asked = approvals.ask(APP, "Bash", { command: "ls" });
    const abort = new AbortController();
    const response = await hono.request("/controller/events", { headers, signal: abort.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) text += decoder.decode((await reader.read()).value);
    };
    await readUntil("event: approval");
    await readUntil("\n\n");
    expect(text).toMatch(/event: approval\ndata: \{"type":"approval","id":"ap1"[^\n]*"tool":"Bash"/);

    const bad = await hono.request("/controller/approvals/ap1", { method: "POST", headers, body: JSON.stringify({ behaviour: "yes" }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_behaviour" });
    const decided = await hono.request("/controller/approvals/ap1", { method: "POST", headers, body: JSON.stringify({ behaviour: "allow" }) });
    expect(await decided.json()).toEqual({ decided: true });
    expect(await asked).toBe(true);
    await readUntil("event: decision");
    await readUntil('"behaviour":"allow"');
    const again = await hono.request("/controller/approvals/ap1", { method: "POST", headers, body: JSON.stringify({ behaviour: "allow" }) });
    expect(again.status).toBe(404);
    abort.abort();
    await reader.cancel().catch(() => {});
  });
});

describe("ControllerService: questions (d3b-6)", () => {
  const QUESTIONS = [
    { question: "Which branch?", header: "Branch", options: [{ label: "main" }, { label: "dev" }], multiSelect: false },
  ];

  it("sends the questions with the approval, takes answers without approve, and validates them", async () => {
    let next = 0;
    const approvals = new ControllerApprovals({ newId: () => `q${++next}` });
    const w = world({ approvals, canApprove: () => false });
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    const events: ControllerEvent[] = [];
    w.service.subscribe((event) => events.push(event));
    const asked = approvals.askQuestions(APP, QUESTIONS, "main");
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(events[0]).toMatchObject({ type: "approval", id: "q1", tool: "AskUserQuestion", questions: QUESTIONS, input: { questions: QUESTIONS } });

    await expect(w.service.decide("q1", { behaviour: "allow" })).rejects.toMatchObject({ status: 400, code: "invalid_answers" });
    await expect(w.service.decide("q1", { behaviour: "allow", answers: { "Other?": "x" } })).rejects.toMatchObject({ status: 400, code: "invalid_answers" });
    expect(await w.service.decide("q1", { behaviour: "allow", answers: { "Which branch?": "dev" } })).toEqual({ decided: true });
    expect(await asked).toEqual({ "Which branch?": "dev" });

    const skipped = approvals.askQuestions(APP, QUESTIONS);
    expect(await w.service.decide("q2", { behaviour: "deny" })).toEqual({ decided: true });
    expect(await skipped).toBe("declined");
  });

  it("tool approvals carry no questions field", async () => {
    const approvals = new ControllerApprovals({ newId: () => "a1" });
    const w = world({ approvals });
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    void approvals.ask(APP, "Bash", {});
    const [event] = await w.service.pendingApprovals();
    expect(event).not.toHaveProperty("questions");
    approvals.decide("a1", "deny");
  });
});

describe("ControllerService: /sudo from the app (§9)", () => {
  function sudoWorld(canSudo = true) {
    const toggled: string[] = [];
    const w = world({
      sudo: {
        canSudo: () => canSudo,
        toggle: async (scope) => {
          toggled.push(scope);
          const on = !w.sudo.has(scope);
          if (on) w.sudo.add(scope); else w.sudo.delete(scope);
          return on;
        },
      },
    });
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    recordParticipant(w.db, DISCORD, "shitiz", "discord");
    return { ...w, toggled };
  }

  it("toggles a writable session, sends the task only when turning on, and returns the row", async () => {
    const w = sudoWorld();
    const id = controllerSessionId(APP);
    expect(await w.service.toggleSudo(id, { task: "restart stockade" })).toMatchObject({ scope: APP, sudo: true });
    expect(w.sent).toEqual([{ scope: APP, text: "restart stockade" }]);
    expect(await w.service.toggleSudo(id, { task: "ignored when turning off" })).toMatchObject({ sudo: false });
    expect(await w.service.toggleSudo(id, {})).toMatchObject({ sudo: true });
    expect(await w.service.toggleSudo(id, { task: "   " })).toMatchObject({ sudo: false });
    expect(w.sent).toHaveLength(1);
  });

  it("refuses read-only, unknown, non-sudoers and bad tasks without toggling", async () => {
    const w = sudoWorld();
    await expect(w.service.toggleSudo(controllerSessionId(DISCORD), {})).rejects.toMatchObject({ status: 403, code: "read_only" });
    await expect(w.service.toggleSudo("000000000000", {})).rejects.toMatchObject({ status: 404 });
    await expect(w.service.toggleSudo(controllerSessionId(APP), { task: 42 })).rejects.toMatchObject({ status: 400 });
    const nobody = sudoWorld(false);
    await expect(nobody.service.toggleSudo(controllerSessionId(APP), {})).rejects.toMatchObject({ status: 403, code: "not_sudoer" });
    expect([...w.toggled, ...nobody.toggled]).toEqual([]);
  });

  it("is unsupported, and not advertised, without sudo mode", async () => {
    const w = world();
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" });
    expect(w.service.capabilities()).not.toContain("sudo");
    expect(sudoWorld().service.capabilities()).toContain("sudo");
    await expect(w.service.toggleSudo(controllerSessionId(APP), {})).rejects.toMatchObject({ status: 404, code: "unsupported" });
  });

  it("is served at POST sessions/:id/sudo", async () => {
    const TOKEN = "t".repeat(40);
    const w = sudoWorld();
    const hono = new Hono();
    mountControllerRoutes(hono, { services: new Map([[TOKEN, w.service]]), controller: { id: "mustafar", name: "Mustafar" } });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const info = await (await hono.request("/controller/info", { headers })).json() as { controller: { capabilities: string[] } };
    expect(info.controller.capabilities).toContain("sudo");
    const response = await hono.request(`/controller/sessions/${controllerSessionId(APP)}/sudo`, { method: "POST", headers, body: JSON.stringify({ task: "go" }) });
    expect(await response.json()).toMatchObject({ scope: APP, sudo: true });
    const readOnly = await hono.request(`/controller/sessions/${controllerSessionId(DISCORD)}/sudo`, { method: "POST", headers, body: "{}" });
    expect(readOnly.status).toBe(403);
  });
});

describe("ControllerService: list budget (Discord lookups cold after a restart)", () => {
  /** A lookup like Discord's: the first call per scope takes `ms` (REST), later ones are cached. */
  function cold<T>(ms: number, answer: (scope: string) => T, slow: (scope: string) => boolean = (scope) => scope.startsWith("discord:")) {
    const warm = new Set<string>();
    return async (scope: string): Promise<T> => {
      if (slow(scope) && !warm.has(scope)) {
        await new Promise((r) => setTimeout(r, ms));
        warm.add(scope);
      }
      return answer(scope);
    };
  }
  const fallbackLabel = (scope: string) => `<#${scope.split(":")[2]}>`;

  function seeded(overrides: Partial<ControllerDeps>) {
    const w = world({ fallbackLabel, listBudgetMs: 50, ...overrides });
    recordParticipant(w.db, DISCORD, "shitiz", "discord", "live", "2026-10-26T10:00:00.000Z");
    recordParticipant(w.db, HIDDEN, "shitiz", "discord", "live", "2026-10-26T10:00:00.000Z");
    bindScope(w.db, { scope: APP, agentId: "main", person: "shitiz", origin: "app" }, "2026-10-26T11:00:00.000Z");
    return w;
  }
  const settle = () => new Promise((r) => setTimeout(r, 300));

  it("a cold list returns within the budget, with fallback labels for labels still resolving", async () => {
    const w = seeded({ describe: cold(250, (scope) => `label of ${scope}`) });
    const started = Date.now();
    const rows = await w.service.sessions();
    expect(Date.now() - started).toBeLessThan(200);
    expect(rows.map((row) => [row.scope, row.label])).toEqual([
      [APP, `label of ${APP}`],
      [DISCORD, "<#general>"],
    ]);
  });

  it("the default budget is about 300 ms, however long Discord takes", async () => {
    const w = seeded({ listBudgetMs: undefined, describe: (scope) => (scope.startsWith("discord:") ? new Promise(() => {}) : Promise.resolve(`label of ${scope}`)) });
    const started = Date.now();
    const rows = await w.service.sessions();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(450);
    expect(rows.find((row) => row.scope === DISCORD)?.label).toBe("<#general>");
  });

  it("later sends the real labels as session events, once per changed row", async () => {
    const w = seeded({ describe: cold(150, (scope) => `label of ${scope}`) });
    const events: ControllerEvent[] = [];
    w.service.subscribe((event) => events.push(event));
    await w.service.sessions();
    await w.service.sessions(); // a second cold list doesn't send the row twice
    expect(events).toEqual([]);
    await settle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "session", session: { scope: DISCORD, label: `label of ${DISCORD}`, writable: false } });
    expect((await w.service.sessions()).find((row) => row.scope === DISCORD)?.label).toBe(`label of ${DISCORD}`);
  });

  it("leaves out a scope whose visibility is still being checked, and sends it once it's allowed (never a hidden one)", async () => {
    const w = seeded({ canView: cold(150, (scope) => scope !== HIDDEN) });
    const events: ControllerEvent[] = [];
    w.service.subscribe((event) => events.push(event));
    const started = Date.now();
    expect((await w.service.sessions()).map((row) => row.scope)).toEqual([APP]);
    expect(Date.now() - started).toBeLessThan(200);
    await settle();
    expect(events.map((event) => event.type === "session" && [event.session.scope, event.session.label])).toEqual([
      [DISCORD, `label of ${DISCORD}`],
    ]);
  });

  it("a warm list is unchanged: the same rows as with no budget, and no events", async () => {
    const w = seeded({});
    const events: ControllerEvent[] = [];
    w.service.subscribe((event) => events.push(event));
    const unbounded = seeded({ listBudgetMs: 60_000 });
    expect(await w.service.sessions()).toEqual(await unbounded.service.sessions());
    expect((await w.service.sessions()).map((row) => row.label)).toEqual([`label of ${APP}`, `label of ${DISCORD}`]);
    await settle();
    expect(events).toEqual([]);
  });

  it("warm() resolves every row with no budget, so the next list has real labels and sends nothing", async () => {
    const w = seeded({ describe: cold(150, (scope) => `label of ${scope}`), canView: cold(100, (scope) => scope !== HIDDEN) });
    const events: ControllerEvent[] = [];
    w.service.subscribe((event) => events.push(event));
    expect(await w.service.warm()).toBe(2);
    expect((await w.service.sessions()).map((row) => row.label)).toEqual([`label of ${APP}`, `label of ${DISCORD}`]);
    await settle();
    expect(events).toEqual([]);
  });

  it("find (transcript, send, sudo) waits for the row instead of the budget", async () => {
    const w = seeded({ describe: cold(150, (scope) => `label of ${scope}`), canView: cold(100, (scope) => scope !== HIDDEN) });
    expect(await w.service.find(controllerSessionId(DISCORD))).toMatchObject({ scope: DISCORD, label: `label of ${DISCORD}` });
    expect(await w.service.find(controllerSessionId(HIDDEN))).toBeNull();
  });
});
