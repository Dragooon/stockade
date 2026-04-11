export { ContainerManager } from "./manager.js";
export { DockerClient } from "./docker.js";
export { PortAllocator } from "./ports.js";
export { provisionContainer } from "./provision.js";
export { resolveDockerfile, resolveImageTag, ensureImage } from "./images.js";
// DispatchQueue removed — replaced by Redis-backed EventBus + OrchestratorBridge
export {
  validateMount,
  validateAdditionalMounts,
  expandPath,
  matchesBlockedPattern,
  mergeBlockedPatterns,
} from "./mounts.js";
export type {
  MountAllowlist,
  AllowedRoot,
  MountRequest,
  MountValidationResult,
  ValidatedMount,
} from "./mounts.js";
export type {
  ContainerConfig,
  ContainersConfig,
  ContainerState,
  CreateContainerOpts,
  ContainerInspect,
  ContainerInfo,
} from "./types.js";
export {
  containerConfigSchema,
  containersConfigSchema,
} from "./types.js";
