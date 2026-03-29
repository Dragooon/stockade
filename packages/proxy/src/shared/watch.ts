import { watch } from "node:fs";
import { loadProxyConfig } from "./config.js";
import type { ProxyConfig } from "./types.js";

/**
 * Watch proxy.yaml for changes and hot-reload config.
 * Debounces filesystem events (editors often trigger multiple writes).
 * Returns a cleanup function to stop watching.
 */
export function watchProxyConfig(
  configDir: string,
  onReload: (config: ProxyConfig) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const watcher = watch(configDir, (_, filename) => {
    if (filename !== "proxy.yaml") return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const next = loadProxyConfig(configDir);
        onReload(next);
        console.log("[watch] proxy.yaml reloaded");
      } catch (err) {
        console.error(
          "[watch] proxy.yaml reload failed, keeping current config:",
          err instanceof Error ? err.message : err,
        );
      }
    }, 300);
  });

  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
