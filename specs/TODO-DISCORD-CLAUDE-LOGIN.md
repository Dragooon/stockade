# TODO: Claude login / token rotation through Discord

Status: not built. Requested 25 Oct 2026.

## Why

Agents with `host_user` / `sudo_user` run Claude as separate OS users (`madge`, `madge-sudo`). Each user has
its own `~/.claude/.credentials.json`; they can't share one, because the OAuth token rotates on every refresh
and each CLI rewrites the file as its own user. Today a person signs each account in at a terminal:

```
sudo -iu madge claude auth login
sudo -iu madge-sudo claude auth login
```

When a login expires, is revoked, or should be rotated, that needs someone at the PC (or SSH). It should work
from Discord.

## Sketch

- Slash command `/claude-login <account>` (choices: the agents' `host_user` / `sudo_user` names). Only users
  with a new RBAC permission `claude-login` (owner); reply ephemeral; refuse in shared channels unless the
  reply can be ephemeral.
- The orchestrator runs `claude auth login --claudeai` as that user through the worker's run-as path
  (`sudo -n -u <user> -- /usr/bin/env -i HOME=… claude auth login`) in a pseudo-terminal, reads the login URL
  from its output and sends it to the requester ephemerally.
- The requester signs in on their phone and sends the code back through a modal (`showModal`, so the code
  never lands in channel history); the orchestrator writes it to the CLI's stdin and reports `claude auth
  status` (logged in, email) when it exits.
- `/claude-logout <account>` runs `claude auth logout` as that user (revocation from Discord).
- Timeouts: kill the CLI if no code arrives within 10 minutes. One login flow per account at a time.
- Never log the URL's state parameter or the code. Audit line: who rotated which account, when.

## Notes

- Same flow covers the break-glass Remote Control session's account (`madge-sudo`): restart that unit after
  a new login.
- Sessions already running keep their in-memory token until they refresh; new sessions pick up the new file.
- Needs a tiny pty helper (e.g. `script -q -c` or `node-pty`), because `claude auth login` expects a terminal.
