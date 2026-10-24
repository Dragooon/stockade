# Stockade on Linux: "thin" mode (Mustafar, since 25 Oct 2026)

Stockade is the Discord bridge and session manager; every agent session is a plain Claude Code
session (Agent SDK) running as an OS user in **auto mode**. No containers, no credential proxy, no
gatekeeper, no host-bash. This file is the operations runbook for that deployment.

## Accounts

| User | What runs as it | Notes |
|---|---|---|
| `stockade` (system, home `/var/lib/stockade`, 0711) | orchestrator + worker | holds the Discord token (systemd credential) and the API token; `CAP_DAC_READ_SEARCH` for the orchestrator only (reads 0600 transcripts) |
| `madge` | everyday sessions | no sudo; workspace `/var/home/madge/workspace`, shared `/var/home/madge/shared` |
| `madge-sudo` | `/sudo` threads + break-glass | passwordless sudo; home 0700 (its settings/hooks/MCP can't be planted by `madge`) |
| group `madge-shared` | madge, madge-sudo, stockade | workspace + shared folder: setgid + default ACL `g:madge-shared:rwX` |

sudoers: `/etc/sudoers.d/50-stockade` (`stockade ALL=(madge,madge-sudo) NOPASSWD: /usr/bin/env`) and
`/etc/sudoers.d/50-madge-sudo` (`madge-sudo ALL=(ALL) NOPASSWD: ALL`).

## How a session runs

1. Discord message → orchestrator (`packages/orchestrator`) → scope → agent (`config.yaml` bindings).
2. The worker (`packages/worker`, a child of the orchestrator, loopback + bearer token, no capabilities)
   starts the Claude CLI through `spawnClaudeCodeProcess`:
   `sudo -n -u <madge|madge-sudo> -- /usr/bin/env -i <allowlisted env> /usr/local/bin/claude …`.
3. cwd = the run-as user's home (its `CLAUDE.md`, `.mcp.json`, `.claude/settings.json`); the workspace is
   added with `--add-dir` (`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` loads the persona). Not the
   workspace as cwd: the SDK blocks all writes to `<cwd>/.claude/skills`.
4. Memory: `autoMemoryDirectory` = `<workspace>/memory` for both users (one Madge, one memory).
5. Permissions: SDK `permissionMode: auto`. The PreToolUse hook only denies (RBAC/agent rules) and never
   answers "allow" (that would skip the classifier). When auto mode wants a human, `canUseTool` → orchestrator
   → Discord Approve/Deny buttons, pressable only by users with the `approve` permission.
6. `autoMode` config comes inline from `agents.<id>.sdk_settings` (the SDK never reads it from project
   settings); sudo sessions get an extra environment line saying they have root.
7. MCP tools that run inside the worker (`agent`, `scheduler`, `sessions`) are the platform's; `send_file`
   reads files as the run-as user; the Discord adapter never reads paths.

## /sudo

`/sudo <task>` (users with the `sudo` permission) opens a private thread, registers it in
`~/.stockade/sudo-scopes.json`, and sends the task as the first message. Every message in that thread runs as
`sudo_user`; only `sudo` holders may talk there; it stops accepting messages after 60 min idle; scheduled
tasks never run in it (they fire in an isolated everyday scope).

## Files and units

- Code: `/var/lib/stockade/repo` (branch `linux-thin`, owner `stockade`, read-only for madge).
- Live config: `/var/lib/stockade/.stockade/config.yaml` (no secrets). Data: `sessions.db`,
  `session-index.db`, `sudo-scopes.json`, `logs/`, `api-token` (0600).
- `stockade.service`: `User=stockade`, `LoadCredentialEncrypted=discord-token`
  (`/etc/credstore.encrypted/discord-token`), `AmbientCapabilities=CAP_DAC_READ_SEARCH`,
  `RestartForceExitStatus=75` (restart signal). Deliberately no systemd sandboxing (sessions are children
  and would inherit it).
- `stockade-redis.service`: Redis in Docker, Unix socket `/var/lib/stockade/run/redis/redis.sock` only
  (directory 0700 stockade), no TCP.
- `madge-breakglass.service`: Remote Control "Mustafar root" as madge-sudo in tmux (`-L breakglass`),
  independent of Stockade. Settings in `~madge-sudo/.claude/settings.json` (auto mode, shared memory).
- Related: `jobtracker.service` (127.0.0.1:3738, MCP for Madge), `openrgb.service` (127.0.0.1:6742,
  `rgb-notify`), madge user units `madge-display` (Xvfb :90) + `madge-chrome` (DevTools 127.0.0.1:9222).

## Deploying a change (in a /sudo session or as an admin)

```bash
sudo -u stockade git -C /var/lib/stockade/repo pull --ff-only     # or from a bundle
cd /var/lib/stockade/repo && sudo -u stockade pnpm install --frozen-lockfile
(cd packages/orchestrator && sudo -u stockade ./node_modules/.bin/tsc --noEmit -p .)
(cd packages/worker && sudo -u stockade ./node_modules/.bin/vitest run)
sudo systemctl restart stockade      # ends every running session, including the one doing this
```
Commit and push every change (`origin` = github.com/Dragooon/stockade).

## Testing without Discord

```bash
sudo -u stockade bash -c 'curl -s -X POST http://127.0.0.1:7420/dispatch \
  -H "Authorization: Bearer $(cat /var/lib/stockade/.stockade/api-token)" -H "Content-Type: application/json" \
  -d "{\"agentId\":\"main\",\"userId\":\"<discord id>\",\"userPlatform\":\"discord\",\"prompt\":\"…\"}"'
```
Add `"scope": "discord:…"` to resume that channel's session (it then contains the test turn).

## Known baseline

`pnpm test` in the orchestrator has 14 failures that predate this mode (container-manager mocks, Redis at
localhost:6379, terminal e2e); they fail on `c1084fc` too.
