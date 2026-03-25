import { Hono } from "hono";
import { WorkerRunRequestSchema } from "./types.js";
import { runAgent } from "./agent.js";

export const app = new Hono();

const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;

app.get("/health", (c) => {
  return c.json({ ok: true, workerId });
});

app.post("/run", async (c) => {
  const body = await c.req.json();

  const parsed = WorkerRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  try {
    const response = await runAgent(parsed.data);
    return c.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 500);
  }
});
