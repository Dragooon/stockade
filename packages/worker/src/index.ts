// Bootstrap HTTP proxy support BEFORE any imports that make network calls.
// When HTTP_PROXY/HTTPS_PROXY are set (container mode with credential proxy),
// this routes all fetch() calls through the proxy for credential injection.
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  const { readFileSync, existsSync } = await import("node:fs");

  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const caCertPath = process.env.NODE_EXTRA_CA_CERTS;

  const opts: Record<string, unknown> = { uri: proxyUrl };
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (noProxy.length) opts.noProxyList = noProxy;
  if (caCertPath && existsSync(caCertPath)) {
    opts.requestTls = { ca: readFileSync(caCertPath, "utf-8") };
  }
  setGlobalDispatcher(new ProxyAgent(opts as any));
}

import { serve } from "@hono/node-server";
import { app, setRedisBridge } from "./server.js";

const port = parseInt(process.env.PORT ?? "3001", 10);
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
const agentId = process.env.AGENT_ID ?? workerId;

// Initialize Redis bridge if REDIS_URL is configured
let redisBridgeRef: import("./redis-bridge.js").WorkerRedisBridge | null = null;
const redisUrl = process.env.REDIS_URL;
if (redisUrl) {
  const { WorkerRedisBridge } = await import("./redis-bridge.js");
  const bridge = new WorkerRedisBridge(redisUrl);

  // Subscribe to control signals for this worker's agentId
  await bridge.subscribeControl(agentId, (signal) => {
    console.log(`[worker] Control signal: ${signal.action}${signal.scope ? ` scope=${signal.scope}` : ""}`);
    // reset_session and abort are handled per-session (loop checks _aborted).
    // shutdown is handled by the orchestrator via SIGTERM/SIGINT.
  });

  setRedisBridge(bridge);
  redisBridgeRef = bridge;
  console.log(`[worker] Redis bridge initialized (url=${redisUrl})`);
}

serve({ fetch: app.fetch, port }, () => {
  console.log(`Worker ${workerId} listening on port ${port}`);
  // Announce to the orchestrator that this worker process is ready.
  // The orchestrator uses this to invalidate stale sessions from the previous
  // worker process and retry any messages that were lost.
  redisBridgeRef?.publishReady(agentId).catch((err: unknown) =>
    console.error("[worker] Failed to publish ready signal:", err)
  );
});
