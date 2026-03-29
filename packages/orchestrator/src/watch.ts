import { watch } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnvFile } from "dotenv";
import { loadConfig } from "./config.js";
import type { AgentsConfig, PlatformConfig } from "./types.js";

/**
 * Watch config.yaml and .env for changes and hot-reload.
 * On .env change, re-reads environment variables first so config
 * substitution (${VAR}) picks up new values.
 *
 * Returns a cleanup function to stop watching.
 */
export function watchConfigFiles(
  configDir: string,
  envPath: string,
  projectRoot: string,
  onReload: (result: { agents: AgentsConfig; platform: PlatformConfig }) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchedFiles = new Set(["config.yaml", ".env"]);

  const reload = () => {
    try {
      // Re-read .env so ${VAR} substitution sees updated values
      loadEnvFile({ path: envPath, override: true });

      const next = loadConfig(configDir, projectRoot);
      onReload(next);
      console.log("[watch] config reloaded");
    } catch (err) {
      console.error(
        "[watch] config reload failed, keeping current config:",
        err instanceof Error ? err.message : err,
      );
    }
  };

  const watcher = watch(configDir, (_, filename) => {
    if (!filename || !watchedFiles.has(filename)) return;
    clearTimeout(timer);
    timer = setTimeout(reload, 300);
  });

  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
