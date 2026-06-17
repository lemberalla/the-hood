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

- OpenAI API adapter
- Anthropic API adapter
- Codex CLI adapter
- Claude Code adapter
- ChatGPT Web adapter as experimental
- Local model adapter

## Phase 5: Worktree And Verification Gates

- Worktree isolation
- Protected path detection
- Runtime validation commands
- Separate verifier flow
- Patch integration

## Phase 6: macOS Menubar Companion

- Active run list
- Approval prompts
- Pause/resume
- Open logs
- Open diffs
- Role switch trigger

The menubar app should talk to the local runtime. It should not own orchestration logic.

## Phase 7: Public Hardening

- Example configs
- Synthetic fixtures
- Integration smoke tests
- Security review
- Contributor docs
- License
- Release workflow

