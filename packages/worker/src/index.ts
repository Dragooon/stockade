// Bootstrap HTTP proxy support BEFORE any imports that make network calls.
// When HTTP_PROXY/HTTPS_PROXY are set (container mode with credential proxy),
// this routes all fetch() calls through the proxy for credential injection.
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  const { readFileSync, existsSync } = await import("node:fs");

  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const caCertPath = process.env.NODE_EXTRA_CA_CERTS;

  const opts: Record<string, unknown> = { uri: proxyUrl };
  if (caCertPath && existsSync(caCertPath)) {
    opts.requestTls = { ca: readFileSync(caCertPath, "utf-8") };
  }
  setGlobalDispatcher(new ProxyAgent(opts as any));
}

import { serve } from "@hono/node-server";
import { app } from "./server.js";

const port = parseInt(process.env.PORT ?? "3001", 10);
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;

serve({ fetch: app.fetch, port }, () => {
  console.log(`Worker ${workerId} listening on port ${port}`);
});
