---
layout: default
title: Architecture
---

# Architecture

## Overview

<pre class="mermaid">
flowchart TB
    U[User<br/>Terminal / Discord] --> O[Orchestrator]
    O --> RBAC[RBAC + Sessions]
    RBAC --> R{Router}
    R --> L[Local Agent<br/>in-process, Agent SDK]
    R --> S[Sandboxed Agent<br/>Container, Worker]
    L --> PE[Permission Engine]
    S --> PE
    PE -->|allow| X[Execute]
    PE -->|deny| B[Block]
    PE -->|ask| GK[Gatekeeper<br/>AI risk review]
    GK -->|low risk| X
    GK -->|high risk| H[Prompt User]
    L -->|HTTP_PROXY| CP[Credential Proxy]
    S -->|HTTP_PROXY| CP
    CP --> NP{Network Policy}
    NP -->|allow| I[Internet]
    NP -->|deny| BL[Blocked]
</pre>

## Packages

| Package | What it does |
|---|---|
| `orchestrator` | Config, RBAC, sessions, routing, channels (terminal + Discord), dispatch, container lifecycle, permission engine, gatekeeper, scheduler |
| `worker` | HTTP server (`/run` + `/health`) wrapping Agent SDK `query()`. Runs inside containers. Stateless. |
| `proxy` | MITM HTTP proxy with TLS interception. Route-based credential injection. SSH tunnel. Gateway API for token management. |

## Message Flow

<pre class="mermaid">
sequenceDiagram
    participant U as User
    participant Ch as Channel
    participant O as Orchestrator
    participant RBAC as RBAC
    participant PE as Permission Engine
    participant A as Agent
    participant P as Credential Proxy
    participant API as Upstream API

    U->>Ch: Message
    Ch->>O: Route message
    O->>RBAC: Check access
    RBAC-->>O: Allowed
    O->>A: Dispatch (local or container)
    A->>PE: Tool invocation
    PE-->>A: allow / deny / ask
    A->>P: HTTPS request (via HTTP_PROXY)
    P->>P: Strip auth headers
    P->>P: Inject credentials
    P->>API: Authenticated request
    API-->>P: Response
    P-->>A: Response
    A-->>O: Result
    O-->>Ch: Reply
    Ch-->>U: Display
</pre>

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

<pre class="mermaid">
flowchart LR
    U[User] --> M[Main Agent]
    M -->|ask_agent| E[Engineer]
    E -->|ask_agent| R[Researcher]

    M -.->|RBAC check| RBAC[Original user's<br/>permissions]
    E -.->|RBAC check| RBAC
    R -.->|RBAC check| RBAC
</pre>

The orchestrator injects an `ask_agent` MCP tool into each agent's session. When an agent calls it:

1. RBAC is re-checked using the **original caller's identity** (not the agent's)
2. The sub-agent is dispatched with its own permissions
3. Result flows back as the tool response

A Discord user's permissions apply even three levels deep: user → main → engineer → researcher.

## Container Lifecycle

<pre class="mermaid">
stateDiagram-v2
    [*] --> Idle
    Idle --> Provisioning: First request
    Provisioning --> Starting: docker create + start
    Starting --> HealthCheck: Container up
    HealthCheck --> Ready: GET /health OK
    HealthCheck --> Failed: Timeout
    Failed --> Provisioning: Retry
    Ready --> Ready: Subsequent requests (reuse)
    Ready --> Stopping: Shutdown / idle timeout
    Stopping --> [*]: docker stop + remove
</pre>

**Shared mode** (default): one container per agent type, reused across sessions. The worker is stateless — each request carries model, system prompt, tools, and session ID.

On first request to a sandboxed agent:

1. Request gateway token from proxy
2. `docker create` with proxy env vars (no secrets)
3. `docker start` + health check
4. Cache container URL for reuse

**Session-isolated mode**: set `container.isolation: session` for per-scope containers. Each conversation gets its own container, torn down on idle timeout.

## Credential Proxy

<pre class="mermaid">
flowchart LR
    A[Agent] -->|HTTPS via HTTP_PROXY| P[Credential Proxy]
    P --> NP{Network Policy}
    NP -->|denied| B[403 Blocked]
    NP -->|allowed| S[Strip Auth Headers]
    S --> M{Match Route?}
    M -->|yes| R[Resolve Credential<br/>file / 1Password / AWS]
    M -->|no| F[Forward as-is]
    R --> I[Inject Header]
    I --> U[Upstream API]
    F --> U
</pre>

Any agent with `credentials` configured routes through the proxy — sandboxed or local. Sandboxed agents are forced through it (only route out of the container). Local agents route through it automatically via the SDK's `env` option when the proxy is running. All HTTPS is intercepted via MITM with a local CA cert:

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

<pre class="mermaid">
flowchart LR
    T[Tool Call] --> R{Match Rules<br/>first-match-wins}
    R -->|allow| E[Execute]
    R -->|deny| B[Block + Error]
    R -->|ask| GK{Gatekeeper}
    R -->|no match| GK
    GK -->|risk ≤ threshold| E
    GK -->|risk > threshold| H[Prompt User]
    H -->|approved| E
    H -->|denied| B
</pre>

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
