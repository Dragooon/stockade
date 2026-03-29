import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as tlsConnect, createSecureContext } from "node:tls";
import * as net from "node:net";
import type { ProxyConfig } from "../shared/types.js";
import { evaluatePolicy } from "../shared/policy.js";
import { resolveCredential } from "../shared/credentials.js";
import { stripHeaders, injectCredential, matchRoute } from "./injector.js";
import { rewriteBody } from "./body-rewriter.js";
import { ensureCA, generateCert, type CaBundle } from "./tls.js";

/**
 * Start the HTTP forward proxy.
 * Handles both plain HTTP (via request handler) and HTTPS (via CONNECT tunnel).
 */
export function startHttpProxy(config: ProxyConfig): ReturnType<typeof createServer> {
  const ca = ensureCA(config.http.tls.ca_cert, config.http.tls.ca_key);

  const server = createServer((req, res) => {
    handleHttpRequest(req, res, config, ca).catch((err) => {
      console.error("[http-proxy] request error:", err);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Bad Gateway");
      }
    });
  });

  // Handle CONNECT for HTTPS tunneling
  server.on("connect", (req, clientSocket: net.Socket, head) => {
    handleConnect(req, clientSocket, head, config, ca).catch((err) => {
      console.error("[http-proxy] CONNECT error:", err);
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  });

  const host = config.host ?? "127.0.0.1";
  server.listen(config.http.port, host, () => {
    console.log(`[http-proxy] listening on ${host}:${config.http.port}`);
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

  const response = await fetch(targetUrl, {
    method,
    headers: { ...headers, host: url.host },
    body: method !== "GET" && method !== "HEAD"
      ? (new Uint8Array(body.buffer, body.byteOffset, body.byteLength) as unknown as BodyInit)
      : undefined,
    redirect: "manual",
  });

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

  // Forward to upstream
  const scheme = port === 443 ? "https" : "http";
  const url = `${scheme}://${host}${path}`;

  const response = await fetch(url, {
    method,
    headers: { ...headers, host },
    body: method !== "GET" && method !== "HEAD" && body.length > 0
      ? (new Uint8Array(body.buffer, body.byteOffset, body.byteLength) as unknown as BodyInit)
      : undefined,
    redirect: "manual",
  });

  // Relay response headers — strip encoding headers since fetch() already decoded them.
  // Node's ServerResponse will handle transfer-encoding/content-length for the client.
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (lk === "transfer-encoding" || lk === "content-encoding" || lk === "content-length") return;
    responseHeaders[key] = value;
  });

  res.writeHead(response.status, responseHeaders);

  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
