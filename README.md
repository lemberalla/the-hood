# TheHood

TheHood is a local, provider-neutral agent runtime for running serious multi-agent software work from Codex, a CLI, and eventually a small macOS menubar companion.

The core idea is simple:

- Models suggest.
- The runtime enforces.
- Users stay in control.

TheHood lets a user assign different models or agent tools to different responsibilities. ChatGPT Pro can orchestrate, Claude Opus can critique, Codex can implement, a cheaper GPT model can perform scoped work, and a separate verifier can test without edit permissions.

The first product surface is a CLI plus an MCP server. The macOS menubar app should remain a thin trigger and status surface over the same local runtime.

## Current Implementation

The first implementation slice is a TypeScript CLI/runtime skeleton.

It supports:

- local project initialization
- JSON config under `.thehood/config.json`
- provider and role inspection
- provider and role health inspection
- Codex-facing MCP tools for role assignment and guest-agent consultation
- role mapping updates
- run creation for `plan` and `implement`
- approval, rejection, abort, status, and log inspection
- hard enforcement that implementer and verifier cannot be the same agent
- a real stdio MCP server exposing TheHood runtime tools
- runtime-owned command log artifacts
- git status/diff evidence capture with protected test-path classification
- deterministic `stub` provider for local loop smoke tests
- `continue` advances runs through orchestrator, implementer, evidence capture, and verifier phases
- schema-bound agent directives and response validation before runtime state advances
- guarded local CLI adapters for Codex CLI and Claude Code
- bridge-backed ChatGPT Web adapter for ChatGPT Pro orchestration
- runtime-captured repo context packs when read-only orchestrators request evidence
- bounded MCP artifact reads for inspecting guest-agent responses from chat

ChatGPT Web is wired through a user-configured bridge command. API provider adapters are not wired to external models yet. Local Codex CLI and Claude Code adapters can be selected by role and must return schema-bound responses.

## Quick Start

```bash
npm install
npm run build
npm run smoke:runtime
npm run smoke:mcp
node dist/cli/main.js init --repo .
node dist/cli/main.js doctor --repo .
node dist/cli/main.js roles --repo .
node dist/cli/main.js run "Implement the first provider adapter" --repo .
node dist/cli/main.js status --repo .
node dist/cli/main.js evidence <run-id> --repo .
node dist/cli/main.js continue <run-id> --repo .
```

## Product Shape

```text
Codex / CLI / macOS menubar
  trigger runs, approvals, status, and configuration

MCP server
  exposes TheHood tools to Codex

Local runtime
  owns state, permissions, logs, worktrees, approvals, and test gates

Provider adapters
  connect to ChatGPT Pro, OpenAI API, Anthropic API, Codex, Claude Code, and local models

Agents
  orchestrator, planner, researcher, implementer, verifier, critic, integrator
```

## Foundation Rules

- The implementer and verifier must not be the same agent.
- The verifier does not get edit tools.
- Runtime-captured logs are the source of truth, not model summaries.
- Test changes require separate classification and review.
- The frontend never owns orchestration logic. It triggers runtime actions.
- Provider choice is user-controlled per role.
- The runtime should be useful headless before it gets a polished UI.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Codex Setup](docs/CODEX_SETUP.md)
- [Runtime Loop](docs/RUNTIME_LOOP.md)
- [Role Contracts](docs/ROLE_CONTRACTS.md)
- [Prompt Schemas](docs/PROMPT_SCHEMAS.md)
- [CLI Spec](docs/CLI_SPEC.md)
- [MCP Spec](docs/MCP_SPEC.md)
- [Provider Adapters](docs/PROVIDER_ADAPTERS.md)
- [Testing And Verification](docs/TESTING_AND_VERIFICATION.md)
- [Security And Privacy](docs/SECURITY_AND_PRIVACY.md)
- [Research Notes](docs/RESEARCH_NOTES.md)
- [Roadmap](docs/ROADMAP.md)
- [Glossary](docs/GLOSSARY.md)
- [Licensing](docs/LICENSING.md)
- [Open Decisions](docs/OPEN_DECISIONS.md)

## Public Repo Docs

- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Agent Instructions](AGENTS.md)

## Decisions

- [0001: Runtime First With CLI And MCP](docs/decisions/0001-runtime-first-cli-and-mcp.md)
- [0002: Provider Neutral Role Mapping](docs/decisions/0002-provider-neutral-role-mapping.md)
- [0003: Separate Implementation And Verification](docs/decisions/0003-separate-implementation-and-verification.md)
