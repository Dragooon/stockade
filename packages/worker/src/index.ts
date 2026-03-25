import { serve } from "@hono/node-server";
import { app } from "./server.js";

const port = parseInt(process.env.PORT ?? "3001", 10);
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;

serve({ fetch: app.fetch, port }, () => {
  console.log(`Worker ${workerId} listening on port ${port}`);
});
