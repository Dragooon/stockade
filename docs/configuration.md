---
layout: default
title: Configuration Reference
---

# Configuration Reference

Everything is defined in two YAML files: `config/config.yaml` (agents, channels, RBAC, containers) and `config/proxy.yaml` (credential proxy, network policy).

## Agents

```yaml
agents:
  main:
    model: claude-sonnet-4-6
    effort: high
    system_mode: append
    system: |
      You are the orchestrator. Delegate to sub-agents.
    tools: [Bash, Read, Write, Edit, Glob, Grep]
    subagents: [researcher, engineer]
    sandboxed: true
    container:
      memory: 2g
      cpus: 2.0
    permissions:
      - "deny:Write(/config/**)"
      - "allow:*"
```

| Field | Required | Description |
|---|---|---|
| `model` | yes | Claude model ID |
| `system` | yes | System prompt |
| `system_mode` | no | `append` (add to SDK default) or `replace`. Default: `replace` |
| `effort` | no | `low`, `medium`, `high`, `max` |
| `tools` | no | Allowed tool names. Omit = all SDK tools |
| `subagents` | no | Agent IDs this agent can delegate to |
| `sandboxed` | no | `true` = run in container. Default: `false` |
| `container` | no | Container resource limits |
| `permissions` | no | Tool permission rules. Omit = allow all |
| `credentials` | no | Proxy credential keys this agent can use |
| `store_keys` | no | Glob patterns for keys the agent can create via `apw store` |

## Permissions

First-match-wins. Actions: `allow`, `deny`, `ask`. Default (no match): `ask`.

```yaml
permissions:
  - "deny:Write(/config/**)"
  - "deny:Bash(rm *)"
  - "allow:Bash(git *)"
  - "allow:Read"
  - "ask:Write"
```

**Selectors:**

| Pattern | Matches |
|---|---|
| `*` | All tools, all invocations |
| `ToolName` | Specific tool, all invocations |
| `ToolName(glob)` | Tool with path or command glob |

**Path prefixes:**

| Prefix | Resolves to |
|---|---|
| `/` | Platform root (`~/.stockade`) |
| `~/` | Home directory |
| `./` | Agent working directory |
| `//` | Absolute path |

Symlinks are resolved. `..` traversal is normalized. Case-insensitive on Windows.

## Gatekeeper

```yaml
gatekeeper:
  enabled: true
  agent: reviewer
  auto_approve_risk: low    # low | medium | high | critical
```

## RBAC

```yaml
rbac:
  roles:
    owner:
      permissions: ["agent:*", "tool:*"]
    user:
      permissions: ["agent:main"]
      deny: ["tool:Bash", "tool:Write", "tool:Edit"]

  users:
    alice:
      roles: [owner]
      identities:
        discord: "123456789012345678"
        terminal: "alice"
```

Identity flows through sub-agent chains. If a user can't use `Bash`, that applies to every agent acting on their behalf.

## Channels

### Terminal

```yaml
channels:
  terminal:
    enabled: true
    agent: main
```

### Discord

```yaml
channels:
  discord:
    enabled: true
    token: ${DISCORD_TOKEN}
    bindings:
      - server: "SERVER_ID"
        agent: main
        channels: "*"
      - server: "OTHER_SERVER"
        agent: researcher
        channels: ["channel-id-1", "channel-id-2"]
```

Agents receive all messages in bound channels. The system prompt determines when to respond vs stay silent.

## Containers

```yaml
containers:
  network: stockade-net
  proxy_host: host.docker.internal
  port_range: [3001, 3099]
  base_dockerfile: ./packages/worker/Dockerfile
  build_context: .
  health_check:
    interval_ms: 500
    timeout_ms: 30000
    retries: 3
  defaults:
    memory: 1g
    cpus: 1.0
  max_age_hours: 0
  max_concurrent: 5
  proxy_ca_cert: ./data/proxy/ca.crt
```

Per-agent overrides:

```yaml
container:
  memory: 4g
  cpus: 4.0
  dockerfile: ./dockerfiles/coder.Dockerfile
  isolation: session
  volumes: ["/data/shared:/data:ro"]
```

Image fallback: agent `dockerfile` → platform `base_dockerfile` → built-in worker Dockerfile. Auto-built on first use, rebuilt when Dockerfile changes.

## Credential Proxy (proxy.yaml)

### Provider

```yaml
provider:
  read:  "cat config/secrets/{key}"
  write: "mkdir -p $(dirname config/secrets/{key}) && printf '%s' '{value}' > config/secrets/{key}"
  update: "printf '%s' '{value}' > config/secrets/{key}"
  cache_ttl: 60
```

Works with any CLI: `op read op://{key}` (1Password), `aws secretsmanager get-secret-value ...` (AWS), etc.

### Network Policy

```yaml
policy:
  default: deny
  rules:
    - host: "api.anthropic.com"
      action: allow
    - host: "api.github.com"
      method: "GET"
      action: allow
    - host: "api.github.com"
      action: deny
```

First-match-wins. Supports `host` (glob), `path` (glob), `method`, `port`.

### Credential Routes

```yaml
routes:
  - host: "api.anthropic.com"
    credential: anthropic-api-key
    inject:
      header: x-api-key

  - host: "api.github.com"
    credential: github-token
    inject:
      header: authorization
      format: "Bearer {value}"
```

### TLS

Auto-generated CA cert on first run. Containers trust it via `NODE_EXTRA_CA_CERTS`.

```yaml
tls:
  ca_cert: data/proxy/ca.crt
  ca_key:  data/proxy/ca.key
```

## Project Structure

```
stockade/
├── packages/
│   ├── orchestrator/    # config, RBAC, sessions, routing, channels, containers
│   ├── worker/          # container HTTP server (Hono + Agent SDK)
│   └── proxy/           # credential proxy (HTTP MITM + SSH + gateway)
├── config/
│   ├── config.example.yaml
│   └── proxy.example.yaml
└── data/                # runtime (gitignored)
```

## Tests

```bash
pnpm test                              # all 749 tests
pnpm -F @stockade/orchestrator test    # 614
pnpm -F @stockade/proxy test           # 117
pnpm -F @stockade/worker test          # 18
```
