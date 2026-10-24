/**
 * Rewrite a proxy/gateway host or URL for use from the host itself.
 *
 * The proxy and gateway listen on loopback only. Containers reach them through
 * host.docker.internal, which Docker Desktop forwards to the host's loopback, but
 * on the host Docker Desktop maps host.docker.internal to the LAN IP (hosts file),
 * where nothing listens. So calls the orchestrator makes itself, and env for
 * unsandboxed agents (which run on the host), must use 127.0.0.1.
 */
export function onHost(hostOrUrl: string): string {
  return hostOrUrl.replace("host.docker.internal", "127.0.0.1");
}
