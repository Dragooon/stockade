---
name: platform-admin
description: >-
  Edit Stockade platform configuration (agents, permissions, channels, RBAC,
  gatekeeper, containers). Use when the user asks to add/remove/modify agents,
  change permissions, update channel bindings, or adjust any platform setting.
  Triggers: "add agent", "change permissions", "update config", "edit settings",
  "modify agent", "add channel", "remove agent", "change model".
---

# Stockade Platform Administration

You are editing the Stockade platform configuration. The live config file is:

```
~/.stockade/config.yaml
```

Read it before making changes. All edits require user authorization (the permission
system enforces `ask` on config writes).

## Config Structure

The config is a single YAML file with these top-level sections:

```yaml
agents:      # Agent definitions (model, tools, permissions, etc.)
channels:    # Channel bindings (terminal, discord)
rbac:        # Role-based access control (roles, users, identities)
containers:  # Docker container settings (for sandboxed agents)
gatekeeper:  # AI risk review configuration
paths:       # Override default data directories (optional)
scheduler:   # Scheduled agent tasks (optional)
```

## Agent Definition Reference

```yaml
agents:
  agent-name:
    model: claude-sonnet-4-6          # Required. Model ID.
    system_mode: append                # "append" (Claude Code preset + custom) or "replace"
    system: |                          # Required. System prompt text.
      Your instructions here.
    effort: high                       # Optional: low, medium, high, max
    tools:                             # Optional. Allowed tool list.
      - Bash
      - Read
      - Write
      - Edit
      - Glob
      - Grep
      - WebSearch
      - WebFetch
    subagents:                         # Optional. Agent IDs this agent can call via ask_agent.
      - other-agent
    sandboxed: false                   # true = Docker container, false = local process
    container:                         # Optional. Container resource limits (sandboxed only).
      memory: 1g
      cpus: 2.0
    credentials:                       # Optional. Credential keys injected via proxy.
      - claude-oauth-token
    store_keys:                        # Optional. Keys this agent can write to the credential store.
      - some-key
    memory:                            # Optional. Agent memory settings.
      enabled: true
      autoDream: false
    permissions:                       # Optional. First-match-wins permission rules.
      - "deny:Write(/config/**)"
      - "ask:Bash(rm *)"
      - "allow:*"
```

### Available Models

- `claude-opus-4-6` — Most capable, highest cost. Use for orchestration.
- `claude-sonnet-4-6` — Balanced. Use for coding, complex tasks.
- `claude-haiku-4-5-20251001` — Fast, cheap. Use for research, lookups.

### Permission Rule Format

```
action:Selector
```

- **Actions**: `allow`, `deny`, `ask` (requires user approval via gatekeeper)
- **Selectors**:
  - `*` — all tools
  - `ToolName` — all invocations of that tool
  - `ToolName(pattern)` — tool with path/command glob

**Path prefixes in patterns:**
- `/` — platform root (`~/.stockade`)
- `~/` — user home directory
- `./` — agent working directory
- `//` — absolute POSIX path

**Examples:**
```yaml
- "deny:Write(/config/**)"       # Block config writes
- "ask:Write(/agents/**)"        # Require approval for agent workspace writes
- "allow:Bash(git *)"            # Allow git commands only
- "allow:Read"                   # Allow all file reads
- "deny:*"                       # Block everything (explicit deny-all)
```

No rule matched = `ask` (HITL approval required).

## Channel Configuration

```yaml
channels:
  terminal:
    enabled: true
    agent: main                       # Agent ID that handles terminal messages

  discord:
    enabled: true
    token: ${DISCORD_TOKEN}           # Env var substitution
    bindings:
      - server: "server-id"
        agent: main
        channels: "*"                 # "*" = all channels, or list specific IDs
```

## RBAC Configuration

```yaml
rbac:
  roles:
    owner:
      permissions:
        - "agent:*"                   # Can talk to any agent
        - "tool:*"                    # No tool restrictions
    user:
      permissions:
        - "agent:main"               # Can only talk to main agent
      deny:
        - "tool:Bash"                # Block dangerous tools
        - "tool:Write"
        - "tool:Edit"
  users:
    username:
      roles:
        - owner
      identities:
        discord: "discord-user-id"   # Platform-specific identity mapping
        terminal: "os-username"
```

User identity flows through the entire sub-agent delegation chain.

## Gatekeeper Configuration

```yaml
gatekeeper:
  enabled: true
  agent: gatekeeper                  # Must reference an agent defined above
  auto_approve_risk: low             # low, medium, high, critical
```

The gatekeeper agent evaluates tool invocations that hit `ask` rules. Its system prompt
controls risk classification. Risk at or below `auto_approve_risk` is auto-approved
(user is notified but not prompted). Higher risk requires explicit user approval.

## Containers Configuration

```yaml
containers:
  network: stockade-net              # Docker network name (internal)
  proxy_host: host.docker.internal   # How containers reach the host proxy
  port_range: [3001, 3099]           # Port pool for container workers
  base_dockerfile: ./packages/worker/Dockerfile
  build_context: .
  health_check:
    interval_ms: 500
    timeout_ms: 30000
    retries: 3
  defaults:
    memory: 1g
    cpus: 1.0
  max_age_hours: 0                   # 0 = no auto-cleanup
  max_concurrent: 5
  proxy_ca_cert: ~/.stockade/proxy/ca.crt
```

## Proxy Configuration (separate file)

The proxy config is at `~/.stockade/proxy.yaml` — it controls credential injection,
network policy, and TLS. Editing it is outside the scope of this skill; mention it
to the user if they ask about credentials or network rules.

## Safety Rules

1. **Always read the current config before editing** — never assume current state.
2. **Show the user what you plan to change** before writing.
3. **Never remove the user's own RBAC entry** — this would lock them out.
4. **Never disable all channels** — at least one must remain enabled.
5. **Validate agent references** — subagents, gatekeeper.agent, and channel bindings
   must reference agents that exist in the `agents` section.
6. **Env vars** — use `${VAR_NAME}` syntax for secrets (tokens, keys). Never hardcode secrets.
7. **After editing**, suggest running `pnpm start:validate` to validate the config.
