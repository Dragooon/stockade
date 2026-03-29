import { describe, it, expect } from "vitest";
import {
  containerConfigSchema,
  containersConfigSchema,
} from "../../src/containers/types.js";

describe("containerConfigSchema", () => {
  it("accepts valid container config with all fields", () => {
    const result = containerConfigSchema.parse({
      dockerfile: "./dockerfiles/coder.Dockerfile",
      isolation: "session",
      memory: "2g",
      cpus: 2.0,
      volumes: ["/data/shared:/data:ro"],
    });

    expect(result.dockerfile).toBe("./dockerfiles/coder.Dockerfile");
    expect(result.isolation).toBe("session");
    expect(result.memory).toBe("2g");
    expect(result.cpus).toBe(2.0);
    expect(result.volumes).toEqual(["/data/shared:/data:ro"]);
  });

  it("defaults isolation to shared", () => {
    const result = containerConfigSchema.parse({});
    expect(result.isolation).toBe("shared");
  });

  it("accepts empty object (all optional)", () => {
    const result = containerConfigSchema.parse({});
    expect(result.isolation).toBe("shared");
    expect(result.dockerfile).toBeUndefined();
    expect(result.memory).toBeUndefined();
    expect(result.cpus).toBeUndefined();
    expect(result.volumes).toBeUndefined();
  });

  it("rejects invalid isolation value", () => {
    expect(() =>
      containerConfigSchema.parse({ isolation: "per-request" })
    ).toThrow();
  });
});

describe("containersConfigSchema", () => {
  it("accepts full config", () => {
    const result = containersConfigSchema.parse({
      network: "my-net",
      proxy_host: "172.17.0.1",
      port_range: [4000, 4099],
      base_dockerfile: "./Dockerfile.base",
      build_context: "./build",
      health_check: {
        interval_ms: 1000,
        timeout_ms: 60000,
        retries: 5,
      },
      defaults: {
        memory: "2g",
        cpus: 2.0,
      },
      max_age_hours: 24,
      session_idle_minutes: 60,
      proxy_ca_cert: "./certs/ca.crt",
    });

    expect(result.network).toBe("my-net");
    expect(result.proxy_host).toBe("172.17.0.1");
    expect(result.port_range).toEqual([4000, 4099]);
    expect(result.health_check.retries).toBe(5);
    expect(result.defaults.memory).toBe("2g");
    expect(result.session_idle_minutes).toBe(60);
  });

  it("applies all defaults when given empty object", () => {
    const result = containersConfigSchema.parse({});

    expect(result.network).toBe("agent-net");
    expect(result.proxy_host).toBe("host.docker.internal");
    expect(result.port_range).toEqual([3001, 3099]);
    expect(result.base_dockerfile).toBe("./packages/worker/Dockerfile");
    expect(result.build_context).toBe(".");
    expect(result.health_check.interval_ms).toBe(500);
    expect(result.health_check.timeout_ms).toBe(30000);
    expect(result.health_check.retries).toBe(3);
    expect(result.defaults.memory).toBe("1g");
    expect(result.defaults.cpus).toBe(1.0);
    expect(result.max_age_hours).toBe(0);
    expect(result.session_idle_minutes).toBe(30);
    expect(result.proxy_ca_cert).toBe("./data/proxy/ca.crt");
  });

  it("partially overrides defaults", () => {
    const result = containersConfigSchema.parse({
      network: "custom-net",
      defaults: { memory: "4g" },
    });

    expect(result.network).toBe("custom-net");
    expect(result.defaults.memory).toBe("4g");
    expect(result.defaults.cpus).toBe(1.0); // default preserved
  });
});
