import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContainersConfig } from "../../src/containers/types.js";
import type { AgentConfig } from "../../src/types.js";

// Mock fs.statSync
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: vi.fn(),
  };
});

const { statSync } = await import("node:fs");

const {
  resolveDockerfile,
  resolveImageTag,
  ensureImage,
} = await import("../../src/containers/images.js");

const containersConfig: ContainersConfig = {
  network: "agent-net",
  proxy_host: "host.docker.internal",
  port_range: [3001, 3099],
  base_dockerfile: "./packages/worker/Dockerfile",
  build_context: ".",
  health_check: { interval_ms: 500, timeout_ms: 30000, retries: 3 },
  defaults: { memory: "1g", cpus: 1.0 },
  max_age_hours: 0,
  session_idle_minutes: 30,
  proxy_ca_cert: "./data/proxy/ca.crt",
};

describe("resolveDockerfile", () => {
  it("uses agent-level Dockerfile when specified", () => {
    const agent: AgentConfig = {
      model: "sonnet",
      system: "test",
      tools: [],
      sandboxed: true,
      container: {
        isolation: "shared",
        dockerfile: "./dockerfiles/coder.Dockerfile",
      },
    };
    const result = resolveDockerfile(agent, containersConfig);
    expect(result).toContain("dockerfiles");
    expect(result).toContain("coder.Dockerfile");
  });

  it("falls back to platform base_dockerfile when agent has no dockerfile", () => {
    const agent: AgentConfig = {
      model: "sonnet",
      system: "test",
      tools: [],
      sandboxed: true,
    };
    const result = resolveDockerfile(agent, containersConfig);
    expect(result).toContain("packages");
    expect(result).toContain("worker");
    expect(result).toContain("Dockerfile");
  });

  it("falls back to platform base when container config exists but no dockerfile", () => {
    const agent: AgentConfig = {
      model: "sonnet",
      system: "test",
      tools: [],
      sandboxed: true,
      container: { isolation: "session" },
    };
    const result = resolveDockerfile(agent, containersConfig);
    expect(result).toContain("worker");
  });
});

describe("resolveImageTag", () => {
  it("derives tag from Dockerfile name", () => {
    expect(resolveImageTag("/path/to/coder.Dockerfile")).toBe(
      "stockade/coder"
    );
  });

  it("handles plain Dockerfile name → worker", () => {
    expect(resolveImageTag("/path/to/Dockerfile")).toBe(
      "stockade/worker"
    );
  });

  it("handles case-insensitive .dockerfile extension", () => {
    expect(resolveImageTag("/path/to/Browser.DOCKERFILE")).toBe(
      "stockade/browser"
    );
  });

  it("lowercases the tag", () => {
    expect(resolveImageTag("/path/to/MyAgent.Dockerfile")).toBe(
      "stockade/myagent"
    );
  });
});

describe("ensureImage", () => {
  let docker: {
    imageExists: ReturnType<typeof vi.fn>;
    imageCreatedAt: ReturnType<typeof vi.fn>;
    buildImage: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    docker = {
      imageExists: vi.fn(),
      imageCreatedAt: vi.fn(),
      buildImage: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("builds image when it does not exist", async () => {
    docker.imageExists.mockResolvedValue(false);

    const tag = await ensureImage(
      docker as any,
      "/path/to/Dockerfile",
      containersConfig
    );

    expect(tag).toBe("stockade/worker");
    expect(docker.buildImage).toHaveBeenCalledWith({
      dockerfile: "/path/to/Dockerfile",
      tag: "stockade/worker",
      context: expect.any(String),
    });
  });

  it("skips build when image exists and Dockerfile is older", async () => {
    docker.imageExists.mockResolvedValue(true);
    docker.imageCreatedAt.mockResolvedValue(Date.now());
    (statSync as any).mockReturnValue({ mtimeMs: Date.now() - 10000 });

    const tag = await ensureImage(
      docker as any,
      "/path/to/Dockerfile",
      containersConfig
    );

    expect(tag).toBe("stockade/worker");
    expect(docker.buildImage).not.toHaveBeenCalled();
  });

  it("rebuilds when Dockerfile is newer than image", async () => {
    docker.imageExists.mockResolvedValue(true);
    docker.imageCreatedAt.mockResolvedValue(Date.now() - 10000);
    (statSync as any).mockReturnValue({ mtimeMs: Date.now() });

    const tag = await ensureImage(
      docker as any,
      "/path/to/Dockerfile",
      containersConfig
    );

    expect(tag).toBe("stockade/worker");
    expect(docker.buildImage).toHaveBeenCalled();
  });

  it("does not rebuild if stat fails", async () => {
    docker.imageExists.mockResolvedValue(true);
    (statSync as any).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const tag = await ensureImage(
      docker as any,
      "/path/to/Dockerfile",
      containersConfig
    );

    expect(tag).toBe("stockade/worker");
    expect(docker.buildImage).not.toHaveBeenCalled();
  });
});
