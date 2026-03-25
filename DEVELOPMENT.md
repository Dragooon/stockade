# Agent Platform — Development Methodology

## Overview

This platform is built by **five coordinated agents**, each with a clear role. The orchestrating agent (Opus, this conversation) manages the full lifecycle — spawning builders, verifying their work, and bringing everything together.

## Agent Roles

### Builder Agents (3x Sonnet)

Each builder agent implements one layer independently, following TDD:

| Agent | Layer | Spec | Directory |
|-------|-------|------|-----------|
| **Agent Builder** | Layer 1: Agent Runtime | `specs/SPEC-AGENT.md` | `packages/agent/` |
| **Orchestrator Builder** | Layer 2: Orchestrator | `specs/SPEC-ORCHESTRATOR.md` | `packages/orchestrator/` |
| **Channels Builder** | Layer 3: Channels | `specs/SPEC-CHANNELS.md` | `packages/channels/` |

**Builder responsibilities:**
1. Read their spec in full before writing any code
2. Follow TDD: write tests first, then implement until tests pass
3. Follow the task order defined in the spec (T1.1, T1.2, ... etc.)
4. Run `pnpm test` in their package after each task to confirm all tests pass
5. Do NOT modify files outside their own `packages/<layer>/` directory
6. Do NOT skip tests — every module listed in the spec must have corresponding tests

### Verifier Agent (Sonnet)

Runs after each builder completes a milestone. Its job:

1. Read the relevant spec
2. Read all source files the builder produced
3. Run the test suite (`pnpm test` in the package)
4. Check spec compliance:
   - Are all files from the spec's file structure present?
   - Are all interfaces/types matching the spec?
   - Are all tasks (T*.1 through T*.N) completed?
   - Do tests cover the cases listed in the spec's testing strategy?
5. Check code quality:
   - No `any` types where the spec defines concrete types
   - No skipped/pending tests
   - No hardcoded values that should come from config
   - Error handling present where spec requires it
6. Produce a **verification report**: pass/fail per task, list of issues
7. If issues found: feed them back to the builder agent for fixing

### Finaliser Agent (Sonnet)

Runs once ALL three layers pass verification. Its job:

1. Set up the monorepo root:
   - `pnpm-workspace.yaml`
   - Root `package.json` with workspace scripts
   - Root `tsconfig.base.json`
   - `.gitignore` (data/, node_modules/, .env, dist/)
2. Write sample config files:
   - `config/agents.yaml` — with a `main` agent definition
   - `config/platform.yaml` — with terminal + discord channels, RBAC for the owner user
   - Both using `${ENV_VAR}` substitution for secrets
3. Wire cross-package dependencies:
   - Orchestrator's agent-client points to agent's /run endpoint
   - Channels' orchestrator-client points to orchestrator's /api/message
4. Run full integration test:
   - Start agent on port 3001
   - Start orchestrator on port 3000
   - Send a test message through the terminal channel flow
   - Verify the message reaches the agent and a response comes back
5. Write a root-level startup script that boots all layers in order
6. Run `pnpm install` and `pnpm -r build` from root — everything must compile
7. Run `pnpm -r test` — all tests across all packages must pass

## Development Flow

```
Phase 1: Parallel Build
  ┌──────────────────┐  ┌──────────────────────┐  ┌──────────────────┐
  │  Agent Builder   │  │ Orchestrator Builder  │  │ Channels Builder │
  │  (worktree)      │  │ (worktree)            │  │ (worktree)       │
  │  T1.1 → T1.11   │  │ T2.1 → T2.11         │  │ T3.1 → T3.8     │
  └──────┬───────────┘  └──────────┬────────────┘  └──────┬───────────┘
         │                         │                       │
Phase 2: Verify (after each builder completes)
         ▼                         ▼                       ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │                      Verifier Agent                              │
  │  Checks each layer against its spec, reports issues, loops      │
  └──────────────────────────────────────────────────────────────────┘
         │
Phase 3: Finalise (after all 3 layers verified)
         ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │                     Finaliser Agent                              │
  │  Monorepo setup, config files, integration wiring, E2E test     │
  └──────────────────────────────────────────────────────────────────┘
```

## Environment Setup

### Secrets

Discord credentials extracted from OpenClaw and stored in `config/.env`:

```
DISCORD_TOKEN=<from openclaw.json>
DISCORD_GUILD_ID=1482310397418672170
DISCORD_USER_SHITIZ=274195702220062720
DISCORD_USER_SECONDARY=430744473673269248
```

The `config/.env` file is gitignored. Config files reference secrets via `${DISCORD_TOKEN}` substitution.

### Anthropic API Key

Available as `ANTHROPIC_API_KEY` environment variable (already set in this shell session).

### Prerequisites

- Node.js (available at `C:\Program Files\nodejs\node.exe`)
- pnpm (install if not present: `npm install -g pnpm`)
- TypeScript, vitest — installed per-package

## TDD Protocol

Every builder agent MUST follow this cycle for each task:

1. **Write the test file** for the module (or add test cases to existing test file)
2. **Run the test** — confirm it fails (red)
3. **Implement the module** until the test passes (green)
4. **Run the full package test suite** — confirm no regressions
5. **Move to the next task**

Tests must cover:
- Happy path
- Error cases listed in the spec
- Edge cases (empty input, missing config, timeouts)

## Verification Protocol

The verifier runs a structured checklist:

```
For each layer:
  [ ] All files from spec's file structure exist
  [ ] All types/interfaces match spec definitions
  [ ] All tasks marked in spec are implemented
  [ ] Test suite passes (`pnpm test`)
  [ ] Test coverage matches spec's testing strategy
  [ ] HTTP API matches spec's endpoint definitions
  [ ] Error handling matches spec requirements
  [ ] No TODO/FIXME/HACK comments left in production code
```

If any check fails, the verifier produces a specific remediation list and the builder is re-spawned to fix.

## Finalisation Protocol

```
  [ ] pnpm-workspace.yaml exists and lists all three packages
  [ ] Root package.json has workspace scripts (dev, build, test, start)
  [ ] Root tsconfig.base.json with shared compiler options
  [ ] config/agents.yaml with working agent definition
  [ ] config/platform.yaml with terminal + discord + RBAC
  [ ] .gitignore covers data/, node_modules/, dist/, .env
  [ ] `pnpm install` succeeds from root
  [ ] `pnpm -r build` succeeds (all packages compile)
  [ ] `pnpm -r test` succeeds (all package tests pass)
  [ ] Integration test: terminal message → orchestrator → agent → response
  [ ] Startup script boots all layers in correct order
```

## File Layout (Final)

```
agent-platform/
├── DEVELOPMENT.md              ← this file
├── config/
│   ├── .env                    ← secrets (gitignored)
│   ├── agents.yaml             ← agent definitions
│   └── platform.yaml           ← channels, RBAC
├── specs/
│   ├── ARCHITECTURE.md         ← overview + interface contracts
│   ├── SPEC-AGENT.md           ← Layer 1 spec
│   ├── SPEC-ORCHESTRATOR.md    ← Layer 2 spec
│   └── SPEC-CHANNELS.md        ← Layer 3 spec
├── packages/
│   ├── agent/                  ← Layer 1
│   ├── orchestrator/           ← Layer 2
│   └── channels/               ← Layer 3
├── data/                       ← runtime data (gitignored)
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
└── .gitignore
```
