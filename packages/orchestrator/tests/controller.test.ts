import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { initParticipantsTable, recordParticipant, personParticipation, scopeParticipants } from "../src/participants.js";
import { initScopeBindingsTable, bindScope, getScopeBinding, scopesBoundTo } from "../src/scope-bindings.js";
import { ControllerService, controllerSessionId, type ControllerDeps, type ControllerEvent } from "../src/controller.js";
import { mountControllerRoutes } from "../src/api/controller-routes.js";

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
    claudeSessionId: (scope) => (scope === DISCORD ? "claude-1" : null),
    agents: () => [{ id: "main", name: "Madge" }],
    now: () => NOW,
    ...overrides,
  });
  return { db, service, live, sudo, turnEnded };
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
      controller: { id: "mustafar", name: "Mustafar", kind: "stockade", capabilities: ["list"] },
      person: "shitiz",
    });
    const sessions = await (await get(app, "/controller/sessions", TOKEN)).json() as Array<{ id: string; scope: string }>;
    expect(sessions.map((s) => s.scope)).toEqual([DISCORD]);
    const one = await get(app, `/controller/sessions/${sessions[0].id}`, TOKEN);
    expect(((await one.json()) as { scope: string }).scope).toBe(DISCORD);
    expect((await get(app, "/controller/sessions/000000000000", TOKEN)).status).toBe(404);
    expect(await (await get(app, "/controller/agents", TOKEN)).json()).toEqual([{ id: "main", name: "Madge" }]);

    const unsupported = await get(app, `/controller/sessions/${sessions[0].id}/transcript`, TOKEN);
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
