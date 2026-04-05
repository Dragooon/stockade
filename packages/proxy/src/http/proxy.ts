import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as tlsConnect, createSecureContext } from "node:tls";
import * as net from "node:net";
import { appendFileSync } from "node:fs";
import type { ProxyConfig } from "../shared/types.js";
import { evaluatePolicy } from "../shared/policy.js";
import { resolveCredential } from "../shared/credentials.js";
import { stripHeaders, injectCredential, matchRoute } from "./injector.js";
import { rewriteBody } from "./body-rewriter.js";
import { ensureCA, generateCert, type CaBundle } from "./tls.js";

const AUDIT_LOG = process.env.STOCKADE_AUDIT_LOG ?? "";

function auditWrite(entry: object): void {
  if (!AUDIT_LOG) return;
  try { appendFileSync(AUDIT_LOG, JSON.stringify(entry) + "\n"); } catch {}
}

/** Extract usage stats from a streamed SSE response body. */
function extractUsage(body: string): Record<string, number> {
  const usage: Record<string, number> = {};
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
  return usage;
}

/**
 * Inject cache_control markers into a /v1/messages request body:
 *   - Last system block: { type:"ephemeral", ttl:"1h" } — caches the agent's
 *     platform instructions (block 4) for 1 hour across turns.
 *   - Last user message content: { type:"ephemeral" } — 5-minute cache on the
 *     most recent user turn, useful for tool-call loops and retries.
 *
 * Respects the 4-marker maximum. Skips any block that already has cache_control.
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

    // Count existing cache markers
    for (const blk of req.system ?? []) if (blk.cache_control) markerCount++;
    for (const msg of req.messages ?? []) {
      const c = msg.content;
      if (Array.isArray(c)) for (const item of c) if ((item as Record<string, unknown>).cache_control) markerCount++;
    }

    // 1h cache on last system block (agent platform instructions).
    // scope:global enables cross-request persistence but is only valid for Opus-class models.
    // Haiku supports ttl:1h but not scope:global — using scope:global on Haiku returns 400.
    // For Opus: upgrade to {ttl:"1h", scope:"global"} for cross-request cache hits.
    // For Haiku: upgrade SDK's 5m marker to {ttl:"1h"} (no scope) — still persists 1h within
    //            a session; cross-request persistence relies on prefix-match of system content.
    const isOpus = (req.model ?? "").includes("opus");
    const target1hMarker = isOpus
      ? { type: "ephemeral", ttl: "1h", scope: "global" }
      : { type: "ephemeral", ttl: "1h" };

    if (markerCount < 4 && Array.isArray(req.system) && req.system.length >= 2) {
      const last = req.system[req.system.length - 1];
      const cc = last.cache_control as Record<string, unknown> | undefined;
      const alreadyCorrect = isOpus
        ? cc?.ttl === "1h" && cc?.scope === "global"
        : cc?.ttl === "1h" && !cc?.scope;
      if (!alreadyCorrect) {
        if (!cc) markerCount++; // new marker; existing markers keep same count
        last.cache_control = target1hMarker;
        modified = true;
      }
    }

    // 5m cache on last user message
    if (markerCount < 4 && Array.isArray(req.messages)) {
      for (let i = req.messages.length - 1; i >= 0; i--) {
        const msg = req.messages[i];
        if (msg.role !== "user") continue;
        if (typeof msg.content === "string") {
          // Convert string content to array so we can attach cache_control
          (msg as Record<string, unknown>).content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
          modified = true;
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          const lastItem = msg.content[msg.content.length - 1] as Record<string, unknown>;
          if (!lastItem.cache_control) {
            lastItem.cache_control = { type: "ephemeral" };
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

  // Audit log: full request payload
  const isMessages = host === "api.anthropic.com" && path.includes("/messages") && AUDIT_LOG;
  if (isMessages && method !== "GET" && method !== "HEAD" && body.length > 0) {
    try {
      auditWrite({ ts: new Date().toISOString(), type: "request", host, path, body: JSON.parse(body.toString("utf8")) });
    } catch {}
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

  // Stream response, accumulating for audit log
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

  // Audit log: usage stats from response
  if (isMessages && responseChunks.length > 0) {
    const responseText = Buffer.concat(responseChunks).toString("utf8");
    auditWrite({ ts: new Date().toISOString(), type: "response", host, path, usage: extractUsage(responseText) });
  }
}

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
