import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountBusyRoutes } from "../src/api/busy-routes.js";

const TOKEN = "t".repeat(64);

function appWith(apiToken: string | undefined, busyScopes: (() => string[]) | null) {
  const app = new Hono();
  mountBusyRoutes(app, { apiToken, busyScopes });
  return app;
}

const get = (app: Hono, token?: string) =>
  app.request("/dispatch/busy", { headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } });

describe("GET /dispatch/busy", () => {
  it("lists the scopes with a turn running, sorted", async () => {
    const response = await get(appWith(TOKEN, () => ["discord:g:b", "app:shitiz:a1"]), TOKEN);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ busy: ["app:shitiz:a1", "discord:g:b"] });
  });

  it("answers an empty list when nothing is running", async () => {
    expect(await (await get(appWith(TOKEN, () => []), TOKEN)).json()).toEqual({ busy: [] });
  });

  it("refuses a missing, wrong or truncated token", async () => {
    const app = appWith(TOKEN, () => ["x"]);
    expect((await get(app)).status).toBe(401);
    expect((await get(app, "x".repeat(64))).status).toBe(401);
    expect((await get(app, TOKEN.slice(1))).status).toBe(401);
  });

  it("refuses everyone when Stockade has no API token", async () => {
    expect((await get(appWith(undefined, () => []), "")).status).toBe(401);
    expect((await get(appWith("", () => []), "")).status).toBe(401);
  });

  it("answers 503 before the Redis bridge is up", async () => {
    expect((await get(appWith(TOKEN, null), TOKEN)).status).toBe(503);
  });
});
