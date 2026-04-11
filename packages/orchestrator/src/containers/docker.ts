import type {
  CreateContainerOpts,
  ContainerInspect,
  ContainerInfo,
} from "./types.js";

/**
 * Docker CLI wrapper. Shells out to `docker` via execa.
 * All methods return typed results and throw on failure.
 */
export class DockerClient {
  private async exec(
    args: string[]
  ): Promise<{ stdout: string; stderr: string }> {
    const { execa } = await import("execa");
    return execa("docker", args);
  }

  // ── Network ──────────────────────────────────────────────

  async networkExists(name: string): Promise<boolean> {
    try {
      await this.exec(["network", "inspect", name]);
      return true;
    } catch {
      return false;
    }
  }

  async createNetwork(name: string): Promise<void> {
    await this.exec([
      "network",
      "create",
      "--driver",
      "bridge",
      name,
    ]);
  }

  // ── Containers ───────────────────────────────────────────

  async createContainer(opts: CreateContainerOpts): Promise<string> {
    const args = ["create", "--name", opts.name, "--network", opts.network];

    // Ports
    for (const [container, host] of Object.entries(opts.ports)) {
      args.push("-p", `${host}:${container}`);
    }

    // Environment variables
    for (const [key, value] of Object.entries(opts.env)) {
      args.push("-e", `${key}=${value}`);
    }

    // Volumes
    for (const vol of opts.volumes) {
      args.push("-v", vol);
    }

    // Labels
    for (const [key, value] of Object.entries(opts.labels)) {
      args.push("--label", `${key}=${value}`);
    }

    // Resource limits
    if (opts.memory) {
      args.push("--memory", opts.memory);
    }
    if (opts.cpus !== undefined) {
      args.push("--cpus", String(opts.cpus));
    }

    // Extra host entries
    if (opts.addHost) {
      for (const host of opts.addHost) {
        args.push("--add-host", host);
      }
    }

    if (opts.user) {
      args.push("--user", opts.user);
    }

    args.push(opts.image);

    const { stdout } = await this.exec(args);
    return stdout.trim(); // container ID
  }

  async startContainer(id: string): Promise<void> {
    await this.exec(["start", id]);
  }

  async stopContainer(id: string, timeoutSec = 10): Promise<void> {
    await this.exec(["stop", "-t", String(timeoutSec), id]);
  }

  async removeContainer(id: string): Promise<void> {
    await this.exec(["rm", "-f", id]);
  }

  async inspectContainer(id: string): Promise<ContainerInspect | null> {
    try {
      const { stdout } = await this.exec([
        "inspect",
        "--format",
        "{{json .}}",
        id,
      ]);
      const raw = JSON.parse(stdout);
      return {
        id: raw.Id,
        name: raw.Name?.replace(/^\//, "") ?? "",
        state: {
          running: raw.State?.Running ?? false,
          status: raw.State?.Status ?? "unknown",
        },
        labels: raw.Config?.Labels ?? {},
      };
    } catch {
      return null;
    }
  }

  async listContainers(
    labels?: Record<string, string>
  ): Promise<ContainerInfo[]> {
    const args = [
      "ps",
      "-a",
      "--format",
      "{{json .}}",
    ];

    if (labels) {
      for (const [key, value] of Object.entries(labels)) {
        args.push("--filter", `label=${key}=${value}`);
      }
    }

    const { stdout } = await this.exec(args);
    if (!stdout.trim()) return [];

    return stdout
      .trim()
      .split("\n")
      .map((line) => {
        const raw = JSON.parse(line);
        return {
          id: raw.ID,
          name: raw.Names,
          labels: parseLabels(raw.Labels ?? ""),
          state: raw.State,
          ports: raw.Ports ?? "",
          image: (raw.ImageID ?? raw.Image ?? "").replace(/^sha256:/, "").slice(0, 12),
        };
      });
  }

  // ── Images ───────────────────────────────────────────────

  async imageExists(tag: string): Promise<boolean> {
    try {
      await this.exec(["image", "inspect", tag]);
      return true;
    } catch {
      return false;
    }
  }

  async imageCreatedAt(tag: string): Promise<number | null> {
    try {
      const { stdout } = await this.exec([
        "image",
        "inspect",
        "--format",
        "{{.Created}}",
        tag,
      ]);
      const d = new Date(stdout.trim());
      return isNaN(d.getTime()) ? null : d.getTime();
    } catch {
      return null;
    }
  }

  /** Return the short 12-char image ID for a tag, or null if not found. */
  async imageId(tag: string): Promise<string | null> {
    try {
      const { stdout } = await this.exec(["image", "inspect", "--format", "{{.Id}}", tag]);
      return stdout.trim().replace(/^sha256:/, "").slice(0, 12) || null;
    } catch {
      return null;
    }
  }

  async buildImage(opts: {
    dockerfile: string;
    tag: string;
    context: string;
  }): Promise<void> {
    await this.exec([
      "build",
      "-f",
      opts.dockerfile,
      "-t",
      opts.tag,
      opts.context,
    ]);
  }

  /**
   * Run a short-lived container that exits immediately (`docker run --rm ...`).
   * Used for one-shot operations like volume chown.
   */
  async runEphemeral(args: string[]): Promise<void> {
    await this.exec(["run", "--rm", ...args]);
  }
}

/** Parse Docker label string "key=val,key2=val2" into a Record */
function parseLabels(labels: string): Record<string, string> {
  if (!labels) return {};
  const result: Record<string, string> = {};
  for (const pair of labels.split(",")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) {
      result[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }
  return result;
}
