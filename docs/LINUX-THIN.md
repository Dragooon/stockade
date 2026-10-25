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
7. AskUserQuestion is offered to agents in an SDK permission mode (not bypass): the SDK sends it to
   `canUseTool`, the orchestrator asks in the chat channel (Discord: buttons, a menu for multi-select, "Other…"
   for typed answers; the asker or an approver answers) and returns the answers as the tool input. Runs without
   a channel (scheduler, API) get a refusal telling the agent to decide itself.
8. MCP tools that run inside the worker (`agent`, `scheduler`, `sessions`, `peers`) are the platform's; `send_file`
   reads files as the run-as user; the Discord adapter never reads paths.
9. Claude Code's own cross-session tools (`SendMessage`, `ListAgents`, `FetchInboxMessage`, `TeamCreate`,
   `TeamDelete`) are disallowed in every session, and the inline settings pin `crossSessionInbound: "refuse"`,
   `remoteControlAtStartup: false` and `isolatePeerMachines: true` over any agent `sdk_settings`: natively,
   a session would reach every local Claude session of its OS user, whoever it belongs to.
10. A turn runs as one person from start to end. Identity and the approval/question callbacks are applied
    when a message starts a turn; the same person's next messages join the running turn, anyone else's wait
    and start their own turn when it ends.

## Peers (session-to-session messaging)

Spec: `specs/SPEC-PEERS.md`. Code: `packages/orchestrator/src/peers.ts`, tools in the worker.

- `mcp__peers__list` lists the conversations (Discord channels and threads, terminal sessions) that the
  person the current turn runs for can see, minus the caller's own: `label [ref] · agent · busy|idle|closed ·
  last active (· sudo)`, newest first, at most 50, closed ones only if active in the last 14 days. `ref` is the
  first 6 hex characters of sha256(scope). `api:*` and `#sched:*` scopes are never listed.
- `mcp__peers__send {to, message}` resolves `to` (ref, unique label or `label [ref]`), rechecks visibility,
  and delivers without waiting for a reply. The target sees an orchestrator-stamped header and wrapper:
  ```
  [peer: from <label> [<ref>] · agent <agentId> · on behalf of <person> · host <host>]
  <cross-session-message from="<label> [<ref>]">
  …
  </cross-session-message>
  ```
  `[peer:`, `[sender:`, `[platform:` and the wrapper tags in the text are escaped. The receiver replies with
  its own send to the `from` value; nothing is posted to the sender's channel by the platform.
- The turn a peer message starts runs as the **acting person** (the sender turn's person) for RBAC, carries
  a hop count (limit 6), and raises approvals in the target's own channel with its usual approvers. Its reply
  is posted to the target's channel under `*Message from <label> on behalf of <person>:* <first 300 chars>`
  unless the receiver stays silent (`mcp__agent__no_reply`).
- A scope in sudo mode takes peer messages in its sudo session (as root), like a person's message there;
  peer messages don't keep sudo mode alive. The list tags such scopes `sudo`.
- Guards: 20 sends per sender scope per 10 minutes, 8,000 characters per message, peer text is never parsed as a command. An `api:` scope can be
  messaged only as a reply, by a session it messaged in the last 24 hours; a scheduled sender's header says
  "no reply possible". Offered to conversations, named `api:` conversations and scheduled runs; not to
  `api:<agent>:<uuid>` runs or sub-agents.

## /sudo (sudo mode)

`/sudo [task]` (users with the `sudo` permission: a `sudoer` role held only by the owner) toggles the
**current conversation** (any channel or thread) into sudo mode: the scope is registered in
`~/.stockade/sudo-scopes.json`, its everyday session is closed, and the next message continues the *same*
conversation as `sudo_user`. `/sudo` again (or 60 min without a message) switches it back. A one-off
`[platform: sudo mode ON/OFF/timed out]` line tells the agent. While it's on, everyone with access to the
conversation can still talk to it (only toggling needs `sudo`; approvals stay owner-only); scheduled tasks never run in it (they fire in an isolated everyday scope).

The conversation's transcript is **moved** between the two users' `~/.claude/projects` on each switch
(`syncTranscript` in `run-as.ts`: the orchestrator reads with `CAP_DAC_READ_SEARCH`, writes/deletes as the
owners via sudo), so there is only ever one copy; a failed hand-over errors out instead of resuming a stale
copy. Trade-off accepted by the owner (25 Oct 2026): context flows both ways (root output stays in the
conversation; earlier everyday context reaches the root session).

## Files and units

- Code: `/var/lib/stockade/repo` (branch `master`, owner `stockade`, read-only for madge).
- Live config: `/var/lib/stockade/.stockade/config.yaml` (no secrets). Data: `sessions.db`,
  `session-index.db`, `sudo-scopes.json`, `logs/`, `api-token` (0600).
- `sessions.db` table `scope_participants(scope, person, platform, source, first_ts, last_ts)`: who took
  part in each scope (platform = discord/terminal for people's messages, `peer` for a peer message acting
  for them, `api` for /dispatch into a named scope). Filled once from `session-index.db` at the first start
  after it was added (`source = 'backfill'`, journal line `[participants] backfill: …`).
- `sessions.db` table `scope_bindings(scope, agent_id, person, origin, created_ts)`: the agent and owner of
  `app:` (started from the controller app) and `peer:` (started by an agent) scopes, which config bindings
  don't cover. Written once when the scope is created and never changed; survives /new. Only the bound person
  sees such a scope (peers list, session history) and they count as conversations like Discord and terminal.
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
Add `"scope": "discord:…"` to resume that channel's session (it then contains the test turn), and
`"sudo": true` to run as the sudo user.

## Known baseline

`pnpm test` in the orchestrator has 14 failures that predate this mode (container-manager mocks, Redis at
localhost:6379, terminal e2e); they fail on `c1084fc` too.
