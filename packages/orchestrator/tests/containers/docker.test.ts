import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CreateContainerOpts } from "../../src/containers/types.js";

// Mock execa
const mockExeca = vi.fn();
vi.mock("execa", () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

const { DockerClient } = await import("../../src/containers/docker.js");

describe("DockerClient", () => {
  let docker: InstanceType<typeof DockerClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    docker = new DockerClient();
  });

  // ── Network ──

  describe("networkExists", () => {
    it("returns true when network exists", async () => {
      mockExeca.mockResolvedValue({ stdout: "{}", stderr: "" });
      expect(await docker.networkExists("agent-net")).toBe(true);
      expect(mockExeca).toHaveBeenCalledWith("docker", [
        "network",
        "inspect",
        "agent-net",
      ]);
    });

    it("returns false when network does not exist", async () => {
      mockExeca.mockRejectedValue(new Error("not found"));
      expect(await docker.networkExists("agent-net")).toBe(false);
    });
  });

  describe("createNetwork", () => {
    it("creates a bridge network", async () => {
      mockExeca.mockResolvedValue({ stdout: "", stderr: "" });
      await docker.createNetwork("agent-net");
      expect(mockExeca).toHaveBeenCalledWith("docker", [
        "network",
        "create",
        "--driver",
        "bridge",
        "agent-net",
      ]);
    });
  });

  // ── Containers ──

  describe("createContainer", () => {
    it("constructs correct docker create command", async () => {
      mockExeca.mockResolvedValue({ stdout: "abc123\n", stderr: "" });

      const opts: CreateContainerOpts = {
        image: "stockade/worker",
        name: "agent-main",
        network: "agent-net",
        ports: { "3001/tcp": "3001" },
        env: { PORT: "3001", HTTP_PROXY: "http://proxy:10255" },
        volumes: ["/host/ca.crt:/certs/ca.crt:ro"],
        labels: { "stockade": "true", "agent-id": "main" },
        memory: "2g",
        cpus: 2.0,
        addHost: ["host.docker.internal:host-gateway"],
      };

      const id = await docker.createContainer(opts);
      expect(id).toBe("abc123");

      const args = mockExeca.mock.calls[0][1] as string[];
      expect(args[0]).toBe("create");
      expect(args).toContain("--name");
      expect(args).toContain("agent-main");
      expect(args).toContain("--network");
      expect(args).toContain("agent-net");
      expect(args).toContain("-p");
      expect(args).toContain("3001:3001/tcp");
      expect(args).toContain("-e");
      expect(args).toContain("PORT=3001");
      expect(args).toContain("-e");
      expect(args).toContain("HTTP_PROXY=http://proxy:10255");
      expect(args).toContain("-v");
      expect(args).toContain("/host/ca.crt:/certs/ca.crt:ro");
      expect(args).toContain("--label");
      expect(args).toContain("stockade=true");
      expect(args).toContain("--memory");
      expect(args).toContain("2g");
      expect(args).toContain("--cpus");
      expect(args).toContain("2");
      expect(args).toContain("--add-host");
      expect(args).toContain("host.docker.internal:host-gateway");
      // Image is last
      expect(args[args.length - 1]).toBe("stockade/worker");
    });

    it("omits optional fields when not provided", async () => {
      mockExeca.mockResolvedValue({ stdout: "def456\n", stderr: "" });

      const opts: CreateContainerOpts = {
        image: "stockade/worker",
        name: "agent-test",
        network: "agent-net",
        ports: {},
        env: {},
        volumes: [],
        labels: {},
      };

      await docker.createContainer(opts);
      const args = mockExeca.mock.calls[0][1] as string[];
      expect(args).not.toContain("--memory");
      expect(args).not.toContain("--cpus");
      expect(args).not.toContain("--add-host");
    });
  });

  describe("startContainer", () => {
    it("calls docker start", async () => {
      mockExeca.mockResolvedValue({ stdout: "", stderr: "" });
      await docker.startContainer("abc123");
      expect(mockExeca).toHaveBeenCalledWith("docker", ["start", "abc123"]);
    });
  });

  describe("stopContainer", () => {
    it("calls docker stop with timeout", async () => {
      mockExeca.mockResolvedValue({ stdout: "", stderr: "" });
      await docker.stopContainer("abc123", 5);
      expect(mockExeca).toHaveBeenCalledWith("docker", [
        "stop",
        "-t",
        "5",
        "abc123",
      ]);
    });

    it("defaults to 10 second timeout", async () => {
      mockExeca.mockResolvedValue({ stdout: "", stderr: "" });
      await docker.stopContainer("abc123");
      expect(mockExeca).toHaveBeenCalledWith("docker", [
        "stop",
        "-t",
        "10",
        "abc123",
      ]);
    });
  });

  describe("removeContainer", () => {
    it("calls docker rm -f", async () => {
      mockExeca.mockResolvedValue({ stdout: "", stderr: "" });
      await docker.removeContainer("abc123");
      expect(mockExeca).toHaveBeenCalledWith("docker", [
        "rm",
        "-f",
        "abc123",
      ]);
    });
  });

  describe("inspectContainer", () => {
    it("parses inspect output", async () => {
      mockExeca.mockResolvedValue({
        stdout: JSON.stringify({
          Id: "abc123full",
          Name: "/agent-main",
          State: { Running: true, Status: "running" },
          Config: { Labels: { "stockade": "true" } },
        }),
        stderr: "",
      });

      const info = await docker.inspectContainer("abc123");
      expect(info).toEqual({
        id: "abc123full",
        name: "agent-main",
        state: { running: true, status: "running" },
        labels: { "stockade": "true" },
      });
    });

    it("returns null when container not found", async () => {
      mockExeca.mockRejectedValue(new Error("not found"));
      const info = await docker.inspectContainer("nonexistent");
      expect(info).toBeNull();
    });
  });

  describe("listContainers", () => {
    it("parses ps output with label filter", async () => {
      const lines = [
        JSON.stringify({
          ID: "abc123",
          Names: "agent-main",
          Labels: "stockade=true,agent-id=main",
          State: "running",
          Ports: "0.0.0.0:3001->3001/tcp",
        }),
        JSON.stringify({
          ID: "def456",
          Names: "agent-researcher",
          Labels: "stockade=true,agent-id=researcher",
          State: "running",
          Ports: "0.0.0.0:3002->3001/tcp",
        }),
      ].join("\n");

      mockExeca.mockResolvedValue({ stdout: lines, stderr: "" });

      const containers = await docker.listContainers({
        "stockade": "true",
      });

      expect(containers).toHaveLength(2);
      expect(containers[0].id).toBe("abc123");
      expect(containers[0].name).toBe("agent-main");
      expect(containers[0].labels["agent-id"]).toBe("main");
      expect(containers[1].id).toBe("def456");

      const args = mockExeca.mock.calls[0][1] as string[];
      expect(args).toContain("--filter");
      expect(args).toContain("label=stockade=true");
    });

    it("returns empty array for no output", async () => {
      mockExeca.mockResolvedValue({ stdout: "", stderr: "" });
      const containers = await docker.listContainers();
      expect(containers).toEqual([]);
    });
  });

  // ── Images ──

  describe("imageExists", () => {
    it("returns true when image exists", async () => {
      mockExeca.mockResolvedValue({ stdout: "", stderr: "" });
      expect(await docker.imageExists("stockade/worker")).toBe(true);
    });

    it("returns false when image does not exist", async () => {
      mockExeca.mockRejectedValue(new Error("not found"));
      expect(await docker.imageExists("stockade/worker")).toBe(false);
    });
  });

  describe("imageCreatedAt", () => {
    it("returns timestamp from image inspect", async () => {
      mockExeca.mockResolvedValue({
        stdout: "2026-03-26T10:00:00Z\n",
        stderr: "",
      });
      const ts = await docker.imageCreatedAt("stockade/worker");
      expect(ts).toBe(new Date("2026-03-26T10:00:00Z").getTime());
    });

    it("returns null when image not found", async () => {
      mockExeca.mockRejectedValue(new Error("not found"));
      expect(await docker.imageCreatedAt("nope")).toBeNull();
    });
  });

  describe("buildImage", () => {
    it("constructs correct docker build command", async () => {
      mockExeca.mockResolvedValue({ stdout: "", stderr: "" });
      await docker.buildImage({
        dockerfile: "./Dockerfile",
        tag: "stockade/worker",
        context: ".",
      });
      expect(mockExeca).toHaveBeenCalledWith("docker", [
        "build",
        "-f",
        "./Dockerfile",
        "-t",
        "stockade/worker",
        ".",
      ]);
    });
  });
});
