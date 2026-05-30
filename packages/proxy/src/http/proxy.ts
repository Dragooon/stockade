import { spawnSync } from "node:child_process";
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
 * Strip scope:global from any cache_control block in the request.
 *
 * SDK 0.3.x sets cache markers natively (ttl:1h, correct placements, array
 * message format). The only remaining fixup needed is that system[2] still
 * carries scope:global which the Anthropic API rejects with a 400 error.
 *
 * All prior workarounds (TTL upgrade, string→array normalisation, second-to-last
 * user message anchor for SDK bug #269) are no longer needed — validated against
 * live 0.3.148 traffic on 2026-05-23.
 */

const PILLOW_RESIZE = [
  "import sys, io, json, base64",
  "from PIL import Image",
  "MAX = 2000",
  "items = json.loads(sys.stdin.buffer.read())",
  "out = []",
  "for b64 in items:",
  "    raw = base64.b64decode(b64)",
  "    img = Image.open(io.BytesIO(raw))",
  "    w, h = img.size",
  "    if w <= MAX and h <= MAX:",
  "        out.append(b64)",
  "    else:",
  "        img.thumbnail((MAX, MAX), Image.LANCZOS)",
  "        buf = io.BytesIO()",
  "        img.save(buf, format=img.format or 'PNG')",
  "        out.append(base64.b64encode(buf.getvalue()).decode())",
  "print(json.dumps(out))",
].join("\n");

/** Read width/height from PNG IHDR bytes (offset 16–23) without full decode. */
function pngDimensions(b64: string): { w: number; h: number } | null {
  try {
    const raw = Buffer.from(b64.slice(0, 64), "base64");
    if (raw[0] !== 0x89 || raw[1] !== 0x50 || raw[2] !== 0x4e || raw[3] !== 0x47) return null;
    return { w: raw.readUInt32BE(16), h: raw.readUInt32BE(20) };
  } catch { return null; }
}

/**
 * Walk the request body and shrink any image content block exceeding 2000px
 * on either dimension (Anthropic multi-image limit). Covers user messages,
 * tool_result content, and any other nested position.
 */
export function downsizeImages(body: Buffer, host: string, path: string): Buffer {
  if (host !== "api.anthropic.com" || !path.includes("/messages")) return body;
  try {
    const req = JSON.parse(body.toString("utf8")) as { messages?: unknown[] };
    if (!Array.isArray(req.messages)) return body;

    // Collect all base64 image sources that need checking
    const sources: Array<Record<string, unknown>> = [];
    function collect(v: unknown): void {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) { for (const item of v) collect(item); return; }
      const o = v as Record<string, unknown>;
      if (o.type === "image") {
        const src = o.source as Record<string, unknown> | undefined;
        if (src?.type === "base64" && typeof src.data === "string") {
          const dims = pngDimensions(src.data);
          if (!dims || dims.w > 2000 || dims.h > 2000) sources.push(src);
        }
        return;
      }
      for (const val of Object.values(o)) collect(val);
    }
    collect(req.messages);

    if (sources.length === 0) return body;

    // Batch resize via Python/Pillow
    const input = Buffer.from(JSON.stringify(sources.map((s) => s.data)));
    const result = spawnSync("python3", ["-c", PILLOW_RESIZE], {
      input,
      maxBuffer: 200 * 1024 * 1024,
      timeout: 30_000,
    });
    if (result.status !== 0 || !result.stdout?.length) return body;

    const resized = JSON.parse(result.stdout.toString()) as string[];
    if (resized.length !== sources.length) return body;

    for (let i = 0; i < sources.length; i++) sources[i].data = resized[i];
    return Buffer.from(JSON.stringify(req), "utf8");
  } catch { return body; }
}

// cc_version cached from the most recent native Claude Code binary session.
// Workers don't inject this themselves (SDK 0.3.x removed it), so the proxy
// injects it to keep worker requests classified as CLI traffic by Anthropic.
let nativeCcVersion = "2.1.146.0000"; // fallback — kept in sync via updateCcVersionCache

/** Sniff the cc_version from a native CLI session and cache it for worker injection. */
function updateCcVersionCache(body: Buffer, isWorker: boolean, host: string, path: string): void {
  if (isWorker || host !== "api.anthropic.com" || !path.includes("/messages")) return;
  try {
    const req = JSON.parse(body.toString("utf8")) as { system?: Array<{ text?: string }> };
    const text = req.system?.[0]?.text ?? "";
    if (!text.startsWith("x-anthropic-billing-header:")) return;
    const m = text.match(/cc_version=([^;]+)/);
    if (m?.[1]) nativeCcVersion = m[1];
  } catch { /* ignore */ }
}

/**
 * For Stockade worker requests: ensure the billing header looks like a native
 * Claude Code CLI session (cc_entrypoint=cli). SDK 0.3.x injects the header
 * itself but with cc_entrypoint=sdk-ts — rewrite it so requests are classified
 * as CLI traffic (Claude Max subscription billing) rather than API-SDK traffic.
 */
export function injectBillingHeader(body: Buffer, host: string, path: string, isWorker: boolean): Buffer {
  if (!isWorker || host !== "api.anthropic.com" || !path.includes("/messages")) return body;
  try {
    const req = JSON.parse(body.toString("utf8")) as {
      system?: Array<{ type?: string; text?: string; cache_control?: Record<string, unknown> }>;
    };
    const firstText = req.system?.[0]?.text ?? "";

    if (firstText.startsWith("x-anthropic-billing-header:")) {
      // SDK injected a billing header — rewrite it with cli entrypoint and native version
      const newText = firstText
        .replace(/cc_entrypoint=[^;]+/, "cc_entrypoint=cli")
        .replace(/cc_version=[^;]+/, `cc_version=${nativeCcVersion}`);
      if (newText === firstText) return body; // already cli, nothing to do
      req.system![0] = { ...req.system![0], text: newText };
    } else {
      // No billing header at all — inject one (legacy path, SDK 0.2.x already did this)
      req.system = [
        { type: "text", text: `x-anthropic-billing-header: cc_version=${nativeCcVersion}; cc_entrypoint=cli; cch=00000;` },
        ...(req.system ?? []),
      ];
    }
    return Buffer.from(JSON.stringify(req), "utf8");
  } catch {
    return body;
  }
}

export function stripCacheScope(body: Buffer, host: string, path: string): Buffer {
  if (host !== "api.anthropic.com" || !path.includes("/messages")) return body;
  try {
    const req = JSON.parse(body.toString("utf8")) as {
      system?: Array<{ cache_control?: Record<string, unknown> }>;
      messages?: Array<{
        role?: string;
        content: string | Array<{ type?: string; cache_control?: Record<string, unknown> }>;
      }>;
    };
    let modified = false;

    function stripScope(cc: Record<string, unknown> | undefined): void {
      if (cc?.scope) { delete cc.scope; modified = true; }
    }

    for (const blk of req.system ?? []) stripScope(blk.cache_control);
    for (const msg of req.messages ?? []) {
      // Never touch assistant messages — thinking/redacted_thinking blocks must
      // remain byte-identical to the original API response or the API rejects with 400.
      if (msg.role === "assistant") continue;
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          // Extra guard: skip thinking blocks regardless of role.
          if (item.type === "thinking" || item.type === "redacted_thinking") continue;
          stripScope(item.cache_control);
        }
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

  // Strip scope:global from cache_control blocks — API rejects it for all models.
  if (method !== "GET" && method !== "HEAD" && body.length > 0) {
    const stripped = stripCacheScope(body, host, path);
    if (stripped !== body) {
      body = stripped;
      if (headers["content-length"]) headers["content-length"] = String(body.length);
    }
  }

  // A request is a Stockade worker request if it carries the scope header.
  // (stockadeSession is empty for new sessions — only set when resuming.)
  const isWorkerRequest = !!stockadeScope;

  // Keep cc_version in sync from native CLI sessions passing through the proxy.
  if (method !== "GET" && method !== "HEAD" && body.length > 0) {
    updateCcVersionCache(body, isWorkerRequest, host, path);
  }

  // Worker requests (SDK 0.3.x) no longer carry x-anthropic-billing-header; inject it
  // so they remain classified as Claude Code CLI traffic on Anthropic's side.
  if (method !== "GET" && method !== "HEAD" && body.length > 0) {
    const injected = injectBillingHeader(body, host, path, isWorkerRequest);
    if (injected !== body) {
      body = injected;
      if (headers["content-length"]) headers["content-length"] = String(body.length);
    }
  }

  // Downsize any images exceeding Anthropic's 2000px multi-image limit
  if (method !== "GET" && method !== "HEAD" && body.length > 0) {
    const downsized = downsizeImages(body, host, path);
    if (downsized !== body) {
      body = downsized;
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
  if (isMessages && isWorkerRequest && !loggedSessions.has(stockadeScope)) {
    loggedSessions.add(stockadeScope);
    try {
      const parsed = JSON.parse(body.toString("utf8")) as {
        model?: string;
        system?: Array<{ type?: string; text?: string; cache_control?: unknown }>;
      };
      reqWrite({
        ts: new Date().toISOString(),
        session: stockadeSession || undefined,
        agent: stockadeAgent || undefined,
        scope: stockadeScope,
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
