import { describe, it, expect } from "vitest";
import { HttpRemotePeerHost, remoteUrlAllowed, REMOTE_LIST_CACHE_MS } from "../src/peer-remote.js";

const TOKEN = "k".repeat(40);
const FROM = { ref: "abcdef", label: "#general", agent: "main", onBehalfOf: "shitiz" };

function host(answer: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let now = 1_000;
  const fetchFn = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const { status = 200, body } = answer(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const h = new HttpRemotePeerHost({ id: "mac", label: "MacBook", person: "shitiz", url: "http://127.0.0.1:47835/", token: TOKEN, fetch: fetchFn, now: () => now });
  return { h, requests, advance: (ms: number) => { now += ms; } };
}

describe("HttpRemotePeerHost", () => {
  it("sends the token only to loopback http or to https", () => {
    expect(remoteUrlAllowed("http://127.0.0.1:47835")).toBe(true);
    expect(remoteUrlAllowed("http://localhost:1")).toBe(true);
    expect(remoteUrlAllowed("http://[::1]:1")).toBe(true);
    expect(remoteUrlAllowed("https://mac.tailnet:47834")).toBe(true);
    expect(remoteUrlAllowed("http://192.168.8.10:47835")).toBe(false);
    expect(remoteUrlAllowed("ftp://127.0.0.1")).toBe(false);
    expect(() => new HttpRemotePeerHost({ id: "mac", label: "M", person: "p", url: "http://10.0.0.1", token: TOKEN })).toThrow(/loopback/);
  });

  it("lists with the bearer token, caching for a few seconds", async () => {
    const { h, requests, advance } = host(() => ({ body: [{ ref: "123abc", label: "x", agent: "a", status: "idle", lastActive: 1 }, "junk", null] }));
    expect(await h.list()).toEqual([{ ref: "123abc", label: "x", agent: "a", status: "idle", lastActive: 1 }]);
    await h.list();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://127.0.0.1:47835/peers/v1/mac/sessions");
    expect((requests[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    advance(REMOTE_LIST_CACHE_MS);
    await h.list();
    expect(requests).toHaveLength(2);
  });

  it("posts messages, starts and notices, and checks the answer", async () => {
    let body: unknown = { status: "queued" };
    const { h, requests } = host(() => ({ body }));
    expect(await h.message(FROM, "123abc", "hi", 2)).toEqual({ status: "queued" });
    expect(JSON.parse(requests[0].init.body as string)).toEqual({ from: FROM, to: "123abc", text: "hi", hops: 2 });
    body = { status: "started", ref: "fedcba", label: "New" };
    expect(await h.start(FROM, undefined, "go", 1)).toEqual({ status: "started", ref: "fedcba", label: "New" });
    expect(JSON.parse(requests[1].init.body as string)).toEqual({ from: FROM, text: "go", hops: 1 });
    body = { ok: true };
    await h.notice({ ref: "abcdef", label: "#general" }, "123abc", "denied", "denied");
    expect(requests[2].url).toBe("http://127.0.0.1:47835/peers/v1/mac/notice");
    expect(JSON.parse(requests[2].init.body as string)).toEqual({ from: { ref: "abcdef", label: "#general" }, to: "123abc", text: "denied", outcome: "denied" });
    body = { status: "maybe" };
    await expect(h.message(FROM, "123abc", "hi", 1)).rejects.toThrow("unexpected answer");
  });

  it("turns an error status into an error", async () => {
    const { h } = host(() => ({ status: 401, body: { error: "unauthorized" } }));
    await expect(h.list()).rejects.toThrow("daemon answered 401 unauthorized");
  });
});
