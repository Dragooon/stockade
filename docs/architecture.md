---
layout: default
title: Architecture
---

# Architecture

## Overview

```
User (Terminal / Discord)
  │
  ▼
Orchestrator ─── RBAC ─── Sessions (SQLite)
  │
  ├── Permission Engine (allow / deny / ask)
  │     └── Gatekeeper (AI risk review, optional)
  │
  ├── Local Agent (in-process, Agent SDK)
  │
  └── Sandboxed Agent
        └── Container (Docker, internal network, no secrets)
              └── Worker (HTTP server, Agent SDK)
                    └── Credential Proxy (MITM, per-route injection)
                          └── Network Policy (deny-by-default)
                                └── Internet
```

## Packages

| Package | What it does |
|---|---|
| `orchestrator` | Config, RBAC, sessions, routing, channels (terminal + Discord), dispatch, container lifecycle, permission engine, gatekeeper, scheduler |
| `worker` | HTTP server (`/run` + `/health`) wrapping Agent SDK `query()`. Runs inside containers. Stateless. |
| `proxy` | MITM HTTP proxy with TLS interception. Route-based credential injection. SSH tunnel. Gateway API for token management. |

## Message Flow

1. Message arrives via channel (terminal / Discord)
2. RBAC checks caller identity and permissions
3. Router resolves which agent handles the message
4. Agent dispatched:
   - **Sandboxed**: orchestrator ensures container is running, sends `POST /run`
   - **Local**: orchestrator calls Agent SDK `query()` directly
5. On each tool invocation, the permission engine evaluates rules:
   - `allow` → proceed
   - `deny` → block
   - `ask` → gatekeeper reviews risk → auto-approve or prompt user
6. Agent can delegate to sub-agents via `ask_agent` MCP tool
7. Response flows back through the channel

## Sub-Agent Delegation

The orchestrator injects an `ask_agent` MCP tool into each agent's session. When an agent calls it:

1. RBAC is re-checked using the **original caller's identity** (not the agent's)
2. The sub-agent is dispatched with its own permissions
3. Result flows back as the tool response

A Discord user's permissions apply even three levels deep: user → main → engineer → researcher.

## Container Lifecycle

**Shared mode** (default): one container per agent type, reused across sessions. The worker is stateless — each request carries model, system prompt, tools, and session ID.

On first request to a sandboxed agent:

1. Request gateway token from proxy
2. `docker create` with proxy env vars (no secrets)
3. `docker start` + health check
4. Cache container URL for reuse

**Session-isolated mode**: set `container.isolation: session` for per-scope containers. Each conversation gets its own container, torn down on idle timeout.

## Credential Proxy

Containers set `HTTP_PROXY` pointing to the proxy. All HTTPS is intercepted via MITM with a local CA cert:

1. Network policy check (host + path + method allowlist)
2. Strip outgoing auth headers
3. Match route → resolve credential from provider
4. Inject credential into headers
5. Forward to upstream

The credential provider is a CLI command template — works with files, 1Password, AWS Secrets Manager, or anything else:

```yaml
# File-based (default)
read: "cat config/secrets/{key}"

# 1Password
read: "op read op://{key}"
```

## Permission Engine

Per-agent, first-match-wins. Three actions:

| Action | Behavior |
|---|---|
| `allow` | Proceeds silently |
| `deny` | Blocked, agent sees error |
| `ask` | Human-in-the-loop approval (or gatekeeper auto-approve) |

No match defaults to `ask`.

Selectors:

```
"allow:*"                    # all tools
"deny:Write"                 # specific tool, all invocations
"allow:Bash(git *)"          # tool + command glob
"deny:Write(/config/**)"    # tool + path glob
```

Path prefixes: `/` (platform root), `~/` (home), `./` (agent cwd), `//` (absolute).

## Gatekeeper

Optional AI risk review for `ask` rules. A configurable agent evaluates each tool invocation and assigns a risk level (low / medium / high / critical). Actions at or below the threshold are auto-approved with a notification; higher-risk actions are presented to the user with the review attached.

---

[Configuration Reference](configuration)
