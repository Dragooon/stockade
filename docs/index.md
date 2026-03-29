---
layout: default
title: Stockade
---

# Stockade

> **Alpha software.** Architecture is stable and tested (749 tests), but APIs and config format may change.

Multi-agent orchestrator for Claude with layered security. Agents run in containers with no secrets, no direct internet, and per-tool permission rules — but you can poke precise holes when you need to.

[Quick Start](quickstart) | [Architecture](architecture) | [Configuration Reference](configuration) | [GitHub](https://github.com/Dragooon/stockade)

## Built on Claude Code

Stockade runs on the [Anthropic Agent SDK](https://github.com/anthropic-ai/claude-code-sdk) — the same runtime that powers Claude Code. Each agent is a Claude Code session with access to built-in tools: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`.

What Stockade adds:

- **Multi-agent orchestration** — parent agents delegate via `ask_agent` MCP tool
- **Remote execution** — Agent SDK runs inside containers, dispatched via HTTP
- **Permission layer** — `allow` / `deny` / `ask` rules per agent, per tool, per path
- **Credential isolation** — MITM proxy injects API keys at the network level
- **Session management** — channel scopes mapped to SDK session IDs in SQLite

## Security Layers

| Layer | What it does |
|---|---|
| **Container isolation** | Sandboxed agents run in Docker on an internal network. No direct internet. |
| **Credential proxy** | MITM proxy strips auth headers and injects credentials per route. Agents never see API keys. |
| **Tool permissions** | Per-agent `allow`/`deny`/`ask` rules with path globs. No match = ask user. |
| **Gatekeeper** | AI risk assessment for `ask` rules. Auto-approves low-risk, prompts for higher. |
| **RBAC** | User roles control agent and tool access. Identity flows through sub-agent chains. |
| **Network policy** | Deny-by-default allowlist per host, path, and HTTP method. |

## Comparison

| | OpenClaw | NanoClaw | NemoClaw | Stockade |
|---|---|---|---|---|
| **Isolation** | Optional containers, app-level perms | Container per group | Landlock + seccomp + netns | 6-layer (see above) |
| **Credentials** | In-process | Gateway injection | Host-only via OpenShell | MITM proxy, per-route |
| **Multi-agent** | Single | Single per group | Single (wraps OpenClaw) | Hierarchical `ask_agent` MCP |
| **Codebase** | ~500k lines | ~2k lines | Thin CLI over OpenClaw | ~8k lines, 749 tests |
| **Status** | Production | Production | Alpha | Alpha |
