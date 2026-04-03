import { Hono } from "hono";
import { WorkerRunRequestSchema } from "./types.js";
import { runAgent } from "./agent.js";

export const app = new Hono();

const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;

app.get("/health", (c) => {
  return c.json({ ok: true, workerId });
});

app.post("/run", async (c) => {
  const start = Date.now();
  const body = await c.req.json();

  const parsed = WorkerRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const { scope, model } = parsed.data;
  console.log(
    `[worker] POST /run — scope: ${scope ?? "—"}, model: ${model ?? "default"}`
  );

  try {
    const response = await runAgent(parsed.data);
    const duration = Date.now() - start;
    console.log(`[worker] POST /run — completed in ${duration}ms`);
    return c.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[worker] POST /run — error: ${message}`);
    return c.json({ error: message }, 500);
  }
});
