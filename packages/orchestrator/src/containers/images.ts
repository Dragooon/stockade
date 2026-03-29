import { resolve, basename } from "node:path";
import { statSync } from "node:fs";
import type { DockerClient } from "./docker.js";
import type { ContainersConfig } from "./types.js";
import type { AgentConfig } from "../types.js";

/**
 * Resolve which Dockerfile to use for an agent.
 * Three-level fallback: agent → platform → built-in worker Dockerfile.
 */
export function resolveDockerfile(
  agentConfig: AgentConfig,
  containersConfig: ContainersConfig
): string {
  if (agentConfig.container?.dockerfile) {
    return resolve(containersConfig.build_context, agentConfig.container.dockerfile);
  }
  return resolve(containersConfig.build_context, containersConfig.base_dockerfile);
}

/**
 * Derive a deterministic image tag from the Dockerfile path.
 * e.g., "./dockerfiles/coder.Dockerfile" → "stockade/coder"
 * e.g., "./packages/worker/Dockerfile" → "stockade/worker"
 */
export function resolveImageTag(dockerfilePath: string): string {
  const name = basename(dockerfilePath)
    .replace(/\.dockerfile$/i, "")
    .replace(/^dockerfile$/i, "worker")
    .toLowerCase();
  return `stockade/${name}`;
}

/**
 * Ensure the image is built and up-to-date.
 * Builds if missing or if the Dockerfile is newer than the image.
 */
export async function ensureImage(
  docker: DockerClient,
  dockerfilePath: string,
  containersConfig: ContainersConfig
): Promise<string> {
  const tag = resolveImageTag(dockerfilePath);

  const exists = await docker.imageExists(tag);
  if (!exists) {
    await docker.buildImage({
      dockerfile: dockerfilePath,
      tag,
      context: resolve(containersConfig.build_context),
    });
    return tag;
  }

  // Check if Dockerfile is newer than the image
  try {
    const dfStat = statSync(dockerfilePath);
    const imageCreated = await docker.imageCreatedAt(tag);
    if (imageCreated !== null && dfStat.mtimeMs > imageCreated) {
      await docker.buildImage({
        dockerfile: dockerfilePath,
        tag,
        context: resolve(containersConfig.build_context),
      });
    }
  } catch {
    // If stat fails, skip rebuild check
  }

  return tag;
}
