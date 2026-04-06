import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as tlsConnect, createSecureContext } from "node:tls";
import * as net from "node:net";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProxyConfig } from "../shared/types.js";
import { evaluatePolicy } from "../shared/policy.js";
import { resolveCredential } from "../shared/credentials.js";
import { stripHeaders, injectCredential, matchRoute } from "./injector.js";
import { rewriteBody } from "./body-rewriter.js";
import { ensureCA, generateCert, type CaBundle } from "./tls.js";

const META_LOG = join(homedir(), ".stockade", "logs", "cache-meta.ndjson");
const REQ_LOG  = join(homedir(), ".stockade", "logs", "requests.ndjson");

function metaWrite(entry: object): void {
  try { appendFileSync(META_LOG, JSON.stringify(entry) + "\n"); } catch {}
}

function reqWrite(entry: object): void {
  try { appendFileSync(REQ_LOG, JSON.stringify(entry) + "\n"); } catch {}
}

// Track sessions we've already logged a system prompt for — avoids re-logging
// the same (unchanged) system on every turn of the same session.
const loggedSessions = new Set<string>();

/** Extract lightweight request metadata for cache analysis. */
function extractRequestMeta(body: Buffer): { model: string; msg_count: number; user_turns: number; req_bytes: number } | null {
  try {
    const req = JSON.parse(body.toString("utf8")) as { model?: string; messages?: { role: string }[] };
    const messages = req.messages ?? [];
    return {
      model: req.model ?? "unknown",
      msg_count: messages.length,
      user_turns: messages.filter((m) => m.role === "user").length,
      req_bytes: body.length,
    };
  } catch { return null; }
}

/** Extract usage stats from a response body (SSE stream or plain JSON). */
function extractUsage(body: string): Record<string, number> {
  const usage: Record<string, number> = {};

  // Try SSE stream format first (streaming responses)
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const d = JSON.parse(line.slice(6)) as Record<string, unknown>;
      for (const key of ["message_start", "message_delta"] as const) {
        if (d.type === key) {
          const src = key === "message_start"
            ? (d.message as Record<string, unknown>)?.usage
            : d.usage;
          if (src && typeof src === "object") Object.assign(usage, src);
        }
      }
    } catch {}
  }

  // Fall back to plain JSON format (non-streaming responses)
  if (Object.keys(usage).length === 0) {
    try {
      const d = JSON.parse(body) as Record<string, unknown>;
      const src = d.usage;
      if (src && typeof src === "object") Object.assign(usage, src);
    } catch {}
  }

  return usage;
}

/**
 * Normalize user messages and inject cache_control markers.
 *
 * ## SDK cache bug workaround (anthropics/claude-agent-sdk-typescript#269)
 *
 * The SDK injects system-reminder blocks into the last user message each turn,
 * then strips them on replay — changing the format (array[3]→string). Since
 * Anthropic's caching is byte-exact prefix matching, this breaks the prefix at
 * the second-to-last user message on every turn.
 *
 * Workaround: place a cache breakpoint on the **second-to-last user message**,
 * which is always in its stable (stripped) form. This anchors the message history
 * prefix so everything up to that point is cache_read. Only the last user turn
 * (~1–2K tokens) is cache_create — an acceptable loss vs ~11K without the fix.
 * This also means cache_read starts from turn 3 instead of turn 4.
 *
 * We also normalize all string-content user messages to array format, so the
 * stable prefix is byte-identical even if the SDK alternates between string and
 * array representations for historical messages.
 *
 * ## Cache markers (up to 4 total, all ttl:1h):
 *   1. system[2]: SDK sets — proxy strips scope:global and ensures ttl:1h
 *   2. system[last]: proxy sets ttl:1h — platform instructions
 *   3. Second-to-last user message: proxy sets ttl:1h — stable history anchor
 *   4. Last user message: SDK sets — proxy upgrades to ttl:1h
 */
function injectCacheMarkers(body: Buffer, host: string, path: string): Buffer {
  if (host !== "api.anthropic.com" || !path.includes("/messages")) return body;
  try {
    const req = JSON.parse(body.toString("utf8")) as {
      model?: string;
      system?: Array<{ cache_control?: unknown }>;
      messages?: Array<{ role: string; content: string | Array<{ cache_control?: unknown; type?: string; text?: string }> }>;
    };
    let markerCount = 0;
    let modified = false;

    // ── Model-aware cache TTL ──
    // Haiku does not support ttl:"1h" on system or message cache_control — it returns
    // 400 ("system.N.cache_control" invalid_request_error). Use standard ephemeral (5m)
    // for Haiku; use 1h for Opus/Sonnet class models.
    // Note: scope:global was also tried but returns 400 for all models now.
    const isHaiku = (req.model ?? "").includes("haiku");
    const target1hMarker = isHaiku
      ? { type: "ephemeral" }
      : { type: "ephemeral", ttl: "1h" };

    // ── Normalize user messages: string → array[1] ──
    // Ensures byte-stable prefix regardless of SDK format inconsistencies.
    for (const msg of req.messages ?? []) {
      if (msg.role === "user" && typeof msg.content === "string") {
        (msg as Record<string, unknown>).content = [{ type: "text", text: msg.content }];
        modified = true;
      }
    }

    // Count existing cache markers (after normalization)
    for (const blk of req.system ?? []) if (blk.cache_control) markerCount++;
    for (const msg of req.messages ?? []) {
      const c = msg.content;
      if (Array.isArray(c)) for (const item of c) if ((item as Record<string, unknown>).cache_control) markerCount++;
    }

    if (Array.isArray(req.system)) {
      // Strip scope:global from ALL system blocks — API now rejects it
      for (const blk of req.system) {
        const cc = blk.cache_control as Record<string, unknown> | undefined;
        if (cc?.scope) {
          delete cc.scope;
          modified = true;
        }
      }

      // Upgrade last system block to 1h TTL
      if (markerCount < 4 && req.system.length >= 2) {
        const last = req.system[req.system.length - 1];
        const cc = last.cache_control as Record<string, unknown> | undefined;
        if (!cc || cc.ttl !== "1h") {
          if (!cc) markerCount++;
          last.cache_control = target1hMarker;
          modified = true;
        }
      }
    }

    // ── Upgrade all existing message cache markers to 1h TTL ──
    // The SDK sets {type:"ephemeral"} (5m) on the last user message. Upgrade to 1h
    // for consistency and to avoid ttl ordering violations (1h must not follow 5m).
    // Haiku only supports standard ephemeral (no ttl field), so skip upgrade for it.
    for (const msg of req.messages ?? []) {
      const c = msg.content;
      if (!Array.isArray(c)) continue;
      for (const item of c) {
        const cc = (item as Record<string, unknown>).cache_control as Record<string, unknown> | undefined;
        if (cc && !cc.ttl && !isHaiku) {
          cc.ttl = "1h";
          modified = true;
        }
        // Also strip scope:global from message markers
        if (cc?.scope) {
          delete cc.scope;
          modified = true;
        }
      }
    }

    // ── Cache breakpoint on second-to-last user message (stable history anchor) ──
    //
    // The SDK injects system-reminders into the LAST user message as array blocks,
    // then strips them when replaying that message as history (SDK bug #269). This
    // makes the last user message's content unstable across turns.
    //
    // The SECOND-to-last user message was the last message one turn ago. By now,
    // the SDK has already stripped its system-reminders and our proxy has normalized
    // it to array[1] format. That normalized form is what gets written to cache this
    // turn — and it's stable: next turn the SDK sends it as a plain string, we
    // normalize it to the same array[1], and cache_read hits.
    //
    // Placing the anchor here instead of third-to-last:
    //   - Enables cache_read from turn 3 (vs turn 4 with third-to-last)
    //   - Covers 1 extra turn of history per request in cache_read
    //   - Works even for short 2–3 turn conversations
    if (markerCount < 4 && Array.isArray(req.messages)) {
      let userMsgCount = 0;
      for (let i = req.messages.length - 1; i >= 0; i--) {
        const msg = req.messages[i];
        if (msg.role !== "user") continue;
        userMsgCount++;
        if (userMsgCount < 2) continue; // skip only the last user message (unstable zone)
        if (Array.isArray(msg.content) && msg.content.length > 0) {
          const lastItem = msg.content[msg.content.length - 1] as Record<string, unknown>;
          if (!lastItem.cache_control) {
            lastItem.cache_control = target1hMarker;
            markerCount++;
            modified = true;
          }
        }
        break;
      }
    }

    if (!modified) return body;
    return Buffer.from(JSON.stringify(req), "utf8");
  } catch {
    return body;
  }
}

/**
 * Start the HTTP forward proxy.
 * Handles both plain HTTP (via request handler) and HTTPS (via CONNECT tunnel).
 *
 * Accepts a config getter so policy, routes, and provider settings
 * can be hot-reloaded without restarting the server.
 * TLS CA is loaded once at startup (changing certs requires restart).
 */
export function startHttpProxy(getConfig: () => ProxyConfig): ReturnType<typeof createServer> {
  const initialConfig = getConfig();
  const ca = ensureCA(initialConfig.http.tls.ca_cert, initialConfig.http.tls.ca_key);

  const server = createServer((req, res) => {
    handleHttpRequest(req, res, getConfig(), ca).catch((err) => {
      console.error("[http-proxy] request error:", err);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Bad Gateway");
      }
    });
  });

  // Handle CONNECT for HTTPS tunneling
  server.on("connect", (req, clientSocket: net.Socket, head) => {
    // Catch connection resets from client disconnects (keep-alive timeouts, aborted requests)
    clientSocket.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
        console.error("[http-proxy] client socket error:", err);
      }
    });

    handleConnect(req, clientSocket, head, getConfig(), ca).catch((err) => {
      console.error("[http-proxy] CONNECT error:", err);
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  });

  const host = initialConfig.host ?? "127.0.0.1";
  server.listen(initialConfig.http.port, host, () => {
    console.log(`[http-proxy] listening on ${host}:${initialConfig.http.port}`);
  });

  return server;
}

/**
 * Handle a plain HTTP request (non-CONNECT).
 * Policy check → strip headers → credential injection → forward.
 */
async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ProxyConfig,
  ca: CaBundle
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const host = url.hostname;
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Policy check
  const action = evaluatePolicy(config.policy, { host, path, method });
  if (action === "deny") {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end(`Blocked by policy: ${host}${path}`);
    return;
  }

  // Build outgoing headers
  let headers = { ...req.headers } as Record<string, string>;
  delete headers.host; // Will set from URL

  // Only strip auth headers when a route matches (proxy injects its own)
  const route = matchRoute(config.http.routes, host, path, method);
  if (route) {
    headers = stripHeaders(headers, config.http.strip_headers);
    const value = await resolveCredential(config.provider, route.credential);
    headers = injectCredential(headers, route, value);
  }

  // Forward the request
  const targetUrl = url.toString();
  let body = await collectBody(req);

  // Ref token substitution: replace apw-ref:... tokens with real credentials
  if (method !== "GET" && method !== "HEAD") {
    const ct = headers["content-type"] ?? "";
    const rewritten = await rewriteBody(body, ct, config.provider);
    if (rewritten.replaced) {
      body = rewritten.body;
      if (headers["content-length"]) {
        headers["content-length"] = String(body.length);
      }
    }
  }

  const upstreamStart = Date.now();
  const response = await fetch(targetUrl, {
    method,
    headers: { ...headers, host: url.host },
    body: method !== "GET" && method !== "HEAD"
      ? (new Uint8Array(body.buffer, body.byteOffset, body.byteLength) as unknown as BodyInit)
      : undefined,
    redirect: "manual",
  });
  console.log(`[http-proxy] ${method} ${host}${path} → ${response.status} (${((Date.now() - upstreamStart) / 1000).toFixed(1)}s)`);

  // Relay response
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  res.writeHead(response.status, responseHeaders);
  if (response.body) {
    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    };
    await pump();
  } else {
    res.end();
  }
}

/**
 * Handle HTTPS CONNECT tunnel.
 * Performs MITM: terminates client TLS with a dynamic cert,
 * then feeds the decrypted socket into a Node HTTP server so the
 * built-in HTTP parser handles framing, chunked encoding, keep-alive, etc.
 */
async function handleConnect(
  req: IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  config: ProxyConfig,
  ca: CaBundle
): Promise<void> {
  const [host, portStr] = (req.url ?? "").split(":");
  const port = parseInt(portStr, 10) || 443;

  // Policy check on CONNECT
  const action = evaluatePolicy(config.policy, { host, port });
  if (action === "deny") {
    clientSocket.end(
      "HTTP/1.1 403 Forbidden\r\n\r\nBlocked by policy\r\n"
    );
    return;
  }

  // Tell client the tunnel is established
  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

  // Generate a per-hostname cert signed by our CA
  const { cert, key } = generateCert(host, ca);
  const ctx = createSecureContext({ cert, key });

  // Create a TLS server-side socket to decrypt client traffic
  const tls = await import("node:tls");
  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    secureContext: ctx,
  });

  if (head.length > 0) {
    tlsSocket.unshift(head);
  }

  tlsSocket.on("error", (err) => {
    // Client disconnected — normal for keep-alive timeouts
    if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
      console.error("[http-proxy] TLS socket error:", err);
    }
  });

  // Use Node's HTTP parser to properly handle request framing.
  // This supports keep-alive, chunked bodies, pipelining, etc.
  const mitmServer = createServer(async (mitmReq, mitmRes) => {
    try {
      await handleMitmRequest(mitmReq, mitmRes, host, port, config);
    } catch (err) {
      console.error("[http-proxy] MITM error:", err);
      if (!mitmRes.headersSent) {
        mitmRes.writeHead(502, { "Content-Type": "text/plain" });
        mitmRes.end("Bad Gateway");
      }
    }
  });

  // Feed the TLS socket into the HTTP server as a "connection"
  mitmServer.emit("connection", tlsSocket);
}

/**
 * Handle a MITM'd HTTP request using Node's parsed IncomingMessage.
 * Strips auth headers, injects credentials, forwards to upstream.
 */
async function handleMitmRequest(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
  port: number,
  config: ProxyConfig,
): Promise<void> {
  const path = req.url ?? "/";
  const method = req.method ?? "GET";

  // Build outgoing headers
  let headers = { ...req.headers } as Record<string, string>;
  delete headers.host;
  delete headers["accept-encoding"]; // Don't request compression — we serve decompressed

  // Extract and strip Stockade context headers (injected by Claude Code via
  // ANTHROPIC_CUSTOM_HEADERS; must never reach Anthropic's servers)
  const stockadeSession = (headers["x-stockade-session"] ?? "") as string;
  const stockadeAgent   = (headers["x-stockade-agent"]   ?? "") as string;
  const stockadeScope   = (headers["x-stockade-scope"]   ?? "") as string;
  delete headers["x-stockade-session"];
  delete headers["x-stockade-agent"];
  delete headers["x-stockade-scope"];

  // Credential injection: only strip auth headers when a route matches
  // (the proxy will inject its own credential). For non-matched routes,
  // pass existing auth headers through so apps like gogcli can use
  // their own OAuth tokens.
  const route = matchRoute(config.http.routes, host, path, method);
  if (route) {
    headers = stripHeaders(headers, config.http.strip_headers);
    const value = await resolveCredential(config.provider, route.credential);
    headers = injectCredential(headers, route, value);
  }

  // Collect request body
  let body = await collectBody(req);

  // Ref token substitution: replace apw-ref:... tokens with real credentials
  if (method !== "GET" && method !== "HEAD" && body.length > 0) {
    const ct = headers["content-type"] ?? "";
    const rewritten = await rewriteBody(body, ct, config.provider);
    if (rewritten.replaced) {
      body = rewritten.body;
      if (headers["content-length"]) {
        headers["content-length"] = String(body.length);
      }
    }
  }

  // Inject cache markers for Anthropic messages requests:
  //   - 1h cache on last system block (platform instructions, block 4)
  //   - 5m cache on last user message content
  if (method !== "GET" && method !== "HEAD" && body.length > 0) {
    const injected = injectCacheMarkers(body, host, path);
    if (injected !== body) {
      body = injected;
      if (headers["content-length"]) {
        headers["content-length"] = String(body.length);
      }
    }
  }

  // Metadata: capture request info for cache analysis
  const isMessages = host === "api.anthropic.com" && path.includes("/messages")
    && method !== "GET" && method !== "HEAD" && body.length > 0;
  const requestMeta = isMessages ? extractRequestMeta(body) : null;

  // Request log: capture system prompt once per session (deduped by session ID).
  // Logs to requests.ndjson — separate from cache-meta so it can be inspected
  // independently without noise from per-turn usage stats.
  if (isMessages && stockadeSession && !loggedSessions.has(stockadeSession)) {
    loggedSessions.add(stockadeSession);
    try {
      const parsed = JSON.parse(body.toString("utf8")) as {
        model?: string;
        system?: Array<{ type?: string; text?: string; cache_control?: unknown }>;
      };
      reqWrite({
        ts: new Date().toISOString(),
        session: stockadeSession,
        agent: stockadeAgent || undefined,
        scope: stockadeScope || undefined,
        model: parsed.model,
        system: (parsed.system ?? []).map((blk, i) => ({
          index: i,
          type: blk.type,
          cache_control: blk.cache_control,
          bytes: Buffer.byteLength(blk.text ?? "", "utf8"),
          text: blk.text,
        })),
      });
    } catch { /* ignore parse errors */ }
  }

  // Forward to upstream
  const scheme = port === 443 ? "https" : "http";
  const url = `${scheme}://${host}${path}`;

  const upstreamStart = Date.now();
  const response = await fetch(url, {
    method,
    headers: { ...headers, host },
    body: method !== "GET" && method !== "HEAD" && body.length > 0
      ? (new Uint8Array(body.buffer, body.byteOffset, body.byteLength) as unknown as BodyInit)
      : undefined,
    redirect: "manual",
  });
  console.log(`[http-proxy] ${method} ${host}${path} → ${response.status} (${((Date.now() - upstreamStart) / 1000).toFixed(1)}s)`);

  // Relay response headers — strip encoding headers since fetch() already decoded them.
  // Node's ServerResponse will handle transfer-encoding/content-length for the client.
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (lk === "transfer-encoding" || lk === "content-encoding" || lk === "content-length") return;
    responseHeaders[key] = value;
  });

  res.writeHead(response.status, responseHeaders);

  // Stream response, accumulating chunks for usage extraction on messages requests
  const responseChunks: Buffer[] = [];
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      if (isMessages) responseChunks.push(Buffer.from(value));
    }
  }
  res.end();

  // Metadata log: one entry per messages API call with request + usage stats
  if (isMessages && requestMeta && responseChunks.length > 0) {
    const usage = extractUsage(Buffer.concat(responseChunks).toString("utf8"));
    const inputTokens = (usage.input_tokens ?? 0) as number;
    const cacheRead = (usage.cache_read_input_tokens ?? 0) as number;
    const cacheCreate = (usage.cache_creation_input_tokens ?? 0) as number;
    const totalInput = inputTokens + cacheRead;
    metaWrite({
      ts: new Date().toISOString(),
      ...(stockadeSession && { session: stockadeSession }),
      ...(stockadeAgent   && { agent:   stockadeAgent }),
      ...(stockadeScope   && { scope:   stockadeScope }),
      model: requestMeta.model,
      user_turns: requestMeta.user_turns,
      msg_count: requestMeta.msg_count,
      req_bytes: requestMeta.req_bytes,
      latency_ms: Date.now() - upstreamStart,
      input_tokens: inputTokens,
      output_tokens: usage.output_tokens ?? 0,
      cache_read: cacheRead,
      cache_create: cacheCreate,
      cache_read_pct: totalInput > 0 ? Math.round(cacheRead / totalInput * 100) : 0,
    });
  }
}

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
