/**
 * Other controllers (D4) through the person's local cc-controller daemon. The daemon holds
 * the peer pairing and the transport (direct TLS or the relay); Stockade only talks to its
 * loopback peer proxy, with the person's controller token:
 *
 *   GET  {url}/peers/v1/<host>/sessions                        → RemoteListing[]
 *   POST {url}/peers/v1/<host>/message {from, to, text, hops}  → RemoteResult
 *   POST {url}/peers/v1/<host>/start   {from, agent?, text, hops} → RemoteResult
 *   POST {url}/peers/v1/<host>/notice  {from, to, text, outcome?} → {ok}
 *
 * `from.host` is never sent: the daemon names this controller to the other side itself.
 */

import type { RemoteFrom, RemoteListing, RemoteOutcome, RemotePeerHost, RemoteResult, RemoteStatus } from "./peers.js";

export const REMOTE_TIMEOUT_MS = 5_000;
export const REMOTE_LIST_CACHE_MS = 10_000;
const STATUSES: readonly RemoteStatus[] = ["delivered", "queued", "awaiting_approval", "started", "refused"];

/** The token goes only to loopback over http; anything else needs https. */
export function remoteUrlAllowed(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname);
}

export interface HttpRemotePeerHostOptions {
  id: string;
  label: string;
  person: string;
  defaultAgent?: string;
  url: string;
  token: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class HttpRemotePeerHost implements RemotePeerHost {
  readonly id: string;
  readonly label: string;
  readonly person: string;
  readonly defaultAgent?: string;
  private readonly base: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private cache: { at: number; list: RemoteListing[] } | null = null;

  constructor(options: HttpRemotePeerHostOptions) {
    if (!remoteUrlAllowed(options.url)) throw new Error(`peer proxy url must be loopback http or https: ${options.url.slice(0, 80)}`);
    this.id = options.id;
    this.label = options.label;
    this.person = options.person;
    this.defaultAgent = options.defaultAgent;
    this.base = `${options.url.replace(/\/+$/, "")}/peers/v1/${encodeURIComponent(options.id)}`;
    this.token = options.token;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async list(): Promise<RemoteListing[]> {
    if (this.cache && this.now() - this.cache.at < REMOTE_LIST_CACHE_MS) return this.cache.list;
    const body = await this.call("GET", "sessions");
    if (!Array.isArray(body)) throw new Error("sessions: not a list");
    const list = body.filter((s): s is RemoteListing => !!s && typeof s === "object" && typeof (s as RemoteListing).ref === "string");
    this.cache = { at: this.now(), list };
    return list;
  }

  async message(from: RemoteFrom, to: string, text: string, hops: number): Promise<RemoteResult> {
    return this.result(await this.call("POST", "message", { from, to, text, hops }));
  }

  async start(from: RemoteFrom, agent: string | undefined, text: string, hops: number): Promise<RemoteResult> {
    this.cache = null;
    return this.result(await this.call("POST", "start", { from, ...(agent && { agent }), text, hops }));
  }

  async notice(from: { ref: string; label: string }, to: string, text: string, outcome?: RemoteOutcome): Promise<void> {
    await this.call("POST", "notice", { from, to, text, ...(outcome && { outcome }) });
  }

  private result(body: unknown): RemoteResult {
    const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const status = STATUSES.find((s) => s === value.status);
    if (!status) throw new Error(`unexpected answer from the daemon`);
    return {
      status,
      ...(typeof value.reason === "string" && { reason: value.reason.slice(0, 500) }),
      ...(typeof value.ref === "string" && { ref: value.ref }),
      ...(typeof value.label === "string" && { label: value.label.slice(0, 200) }),
    };
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchFn(`${this.base}/${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    const parsed = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const error = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).error : undefined;
      throw new Error(`daemon answered ${response.status}${typeof error === "string" ? ` ${error.slice(0, 60)}` : ""}`);
    }
    return parsed;
  }
}
