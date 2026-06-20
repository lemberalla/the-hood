# Roadmap

The roadmap is documentation-first, runtime-second, UI-last.

## Phase 0: Documentation And Contracts

- Architecture docs
- Role contracts
- Prompt schemas
- CLI spec
- MCP spec
- Provider adapter boundaries
- Security rules
- Verification rules
- ADRs

## Phase 1: Local Runtime Skeleton

- Run store
- State machine
- Event log
- Permission model
- Command runner
- Diff capture
- Config loader
- Typed schemas

## Phase 2: CLI

- `thehood init`
- `thehood config`
- `thehood roles`
- `thehood run`
- `thehood status`
- `thehood logs`
- `thehood approve`
- `thehood continue`
- `thehood abort`

## Phase 3: MCP Server

- `thehood mcp`
- `thehood_plan`
- `thehood_orchestrate`
- `thehood_continue`
- `thehood_status`
- `thehood_abort`

## Phase 4: Provider Adapters

- Codex CLI adapter with live model discovery
- Claude Code adapter with configured/custom model passthrough
- ChatGPT Web adapter as experimental
- OpenAI API adapter
- Anthropic API adapter
- Local model adapter

## Phase 5: Worktree And Verification Gates

- Worktree isolation
- Protected path detection
- Runtime validation commands
- Separate verifier flow
- Patch integration

## Phase 6: Memory And Reconciliation

- Canonical progress packet builder
- Planner reconciliation provider call
- Reconciliation artifacts
- CLI and MCP reconciliation status
- Local index for run memory queries
- Pluggable derived memory engines

## Phase 7: macOS Menubar Companion

- Active run list
- Approval prompts
- Pause/resume
- Open logs
- Open diffs
- Role switch trigger

The menubar app should talk to the local runtime. It should not own orchestration logic.

## Phase 8: Public Hardening

- Example configs
- Synthetic fixtures
- Integration smoke tests
- Security review
- Contributor docs
- License
- Release workflow
