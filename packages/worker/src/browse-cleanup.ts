/**
 * Best-effort cleanup for the Madge Chrome browser profile.
 *
 * chrome-devtools-mcp launches Chrome via Puppeteer. On Windows, when the
 * agent SDK closes the MCP stdio (end of query), Puppeteer doesn't propagate
 * teardown to Chrome — so each Browse run leaves ~13 chrome.exe + 3 node.exe
 * (chrome-devtools-mcp tree) alive, plus a stale `lockfile` in the profile.
 * The next run hits a profile-lock collision and wedges.
 *
 * We call this around every query() in the browse worker:
 *   - Pre-query: clear any orphans from a prior session before the SDK
 *     spawns a fresh chrome-devtools-mcp + Chrome on the same profile.
 *   - Post-query: tear down the MCP tree + Chrome the SDK didn't clean up.
 *
 * Match scope: chrome.exe with `--user-data-dir=*madge*` and node.exe whose
 * command line contains `chrome-devtools-mcp`. User Chrome windows on other
 * profiles are unaffected.
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".agent-browser", "profiles", "madge");
const LOCKFILE = join(PROFILE_DIR, "lockfile");

export function cleanupBrowseChrome(): void {
  try {
    if (process.platform === "win32") {
      const ps =
        "Get-WmiObject Win32_Process -Filter \"Name='chrome.exe'\" | " +
        "Where-Object {$_.CommandLine -like '*--user-data-dir=*madge*'} | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; " +
        "Get-WmiObject Win32_Process -Filter \"Name='node.exe'\" | " +
        "Where-Object {$_.CommandLine -like '*chrome-devtools-mcp*'} | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        stdio: "ignore",
        timeout: 8_000,
      });
    } else {
      spawnSync("pkill", ["-f", "--user-data-dir=.*madge"], { stdio: "ignore", timeout: 5_000 });
      spawnSync("pkill", ["-f", "chrome-devtools-mcp"], { stdio: "ignore", timeout: 5_000 });
    }
    rmSync(LOCKFILE, { force: true });
  } catch {
    // best-effort
  }
}
