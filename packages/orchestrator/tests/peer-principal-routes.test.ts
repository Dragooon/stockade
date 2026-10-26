import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { mountPeerPrincipalRoutes } from "../src/api/peer-principal-routes.js";
import type { PeerCaller, PeerService } from "../src/peers.js";

const TOKEN = "k".repeat(40);
const KEPLER: PeerCaller = {
  scope: "principal:kepler", agentId: "kepler", userId: "kepler", userPlatform: "api", hops: 0,
  principal: { name: "kepler", label: "Kepler", host: "MacBook", forPerson: "shitiz", viewer: { userId: "1", userPlatform: "discord" } },
};

/** A stand-in PeerService that records how it was called. */
function app(callers = new Map([[TOKEN, KEPLER]])) {
  const calls: unknown[][] = [];
  const peers = {
    listTool: async (caller: PeerCaller) => { calls.push(["list", caller.scope]); return "This session is Kepler [abcdef]."; },
    sendTool: async (caller: PeerCaller, to: unknown, message: unknown) => { calls.push(["send", caller.scope, to, message]); return to === "nope" ? "Error: no visible session matches" : "held: #general [123456]"; },
    startTool: async (caller: PeerCaller, host: unknown, agent: unknown, message: unknown) => { calls.push(["start", caller.scope, host, agent, message]); return "started: x"; },
    drainInbox: (principal: string, max: number) => { calls.push(["inbox", principal, max]); return [{ at: "t", kind: "notice", text: "hi" }]; },
  } as unknown as PeerService;
  const hono = new Hono();
  mountPeerPrincipalRoutes(hono, { callers, peers });
  const post = (path: string, body: unknown = {}, token: string | null = TOKEN) => hono.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { post, calls };
}

describe("peer principal routes", () => {
  it("need the principal's token", async () => {
    const { post, calls } = app();
    expect((await post("/peers/list", {}, null)).status).toBe(401);
    expect((await post("/peers/list", {}, "x".repeat(40))).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("don't exist without principals", async () => {
    const { post } = app(new Map());
    expect((await post("/peers/list")).status).toBe(404);
  });

  it("list, send and start act as the token's principal and answer with the tool text", async () => {
    const { post, calls } = app();
    expect(await (await post("/peers/list")).json()).toEqual({ ok: true, text: "This session is Kepler [abcdef]." });
    expect(await (await post("/peers/send", { to: "#general", message: "hi" })).json()).toEqual({ ok: true, text: "held: #general [123456]" });
    expect(await (await post("/peers/send", { to: "nope", message: "hi" })).json()).toEqual({ ok: false, text: "Error: no visible session matches" });
    expect(await (await post("/peers/start", { message: "go", agent: "main" })).json()).toEqual({ ok: true, text: "started: x" });
    expect(calls).toEqual([
      ["list", "principal:kepler"],
      ["send", "principal:kepler", "#general", "hi"],
      ["send", "principal:kepler", "nope", "hi"],
      ["start", "principal:kepler", undefined, "main", "go"],
    ]);
  });

  it("inbox drains the principal's items, at most 200 at a time", async () => {
    const { post, calls } = app();
    expect(await (await post("/peers/inbox")).json()).toEqual({ items: [{ at: "t", kind: "notice", text: "hi" }] });
    await post("/peers/inbox", { max: 1000 });
    await post("/peers/inbox", { max: "5" });
    expect(calls).toEqual([["inbox", "kepler", 50], ["inbox", "kepler", 200], ["inbox", "kepler", 50]]);
  });

  it("a malformed body reads as no arguments, and other paths are unsupported", async () => {
    const { post, calls } = app();
    expect((await post("/peers/send", [1, 2])).status).toBe(200);
    expect(calls).toEqual([["send", "principal:kepler", undefined, undefined]]);
    expect((await post("/peers/other")).status).toBe(404);
  });
});
