# TheHood

TheHood is a local, provider-neutral agent runtime for running serious multi-agent software work from Codex, a CLI, and eventually a small macOS menubar companion.

Status: developer preview. TheHood is preparing for `v0.1.0-preview.0` as a local CLI/MCP runtime for governed software goal loops. It is useful for early adopters who are comfortable with local tools, explicit approval boundaries, and experimental provider wiring. It is not a hosted agent service, cloud scheduler, or polished app platform.

The core idea is simple:

- Models suggest.
- The runtime enforces.
- Users stay in control.

TheHood lets a user assign different models or agent tools to different responsibilities. The product default is Codex-first: Codex can orchestrate, implement, QA, critique, and verify through separate runtime roles, while users can opt into GPT, ChatGPT Pro, Claude Code, future API adapters, or future local models for roles as those paths are wired. Codex becomes the governed workbench; Claude can second-judge or build; Pro can approve strategy when the stakes justify it.

The first product surface is a CLI plus an MCP server. The macOS menubar app should remain a thin trigger and status surface over the same local runtime.

## Works Today

- Local project setup and JSON runtime config under `.thehood/config.json`.
- CLI and stdio MCP control surfaces over the same local runtime.
- Codex-first role mapping with separate orchestrator, planner, implementer, QA, verifier, and critic roles.
- Local Codex CLI and Claude Code command adapters that must return schema-bound responses.
- Deterministic `stub` provider for local smoke tests and synthetic demonstrations.
- Approval gates, protected test/fixture/snapshot/eval classification, isolated patch capture, and runtime-owned integration reports.
- Runtime-owned evidence: command logs, git status/diff snapshots, provider invocation artifacts, final reports, progress packets, review lanes, revision packets, and agent board snapshots.
- Same-run summons and bounded fan-out as read-only sidecar evidence, not acceptance votes.
- ChatGPT Web bridge and ChatGPT MCP connector guidance as experimental, user-configured provider paths.

## Planned Or Experimental

- OpenAI API, Anthropic API, and local model adapters are represented in provider config but are not wired as production external model adapters yet.
- Hosted execution, cloud routines, timer schedules, and overnight automation are not part of `v0.1.0-preview.0`.
- A full web dashboard and macOS menubar app remain future control surfaces over the runtime.
- ChatGPT MCP connector mode depends on ChatGPT custom connector/tunnel availability in the user's workspace and should be treated as optional.
- Native Codex visual rendering beyond explicit artifact/dashboard payloads remains a later integration layer.

## Current Implementation

The first implementation slice is a TypeScript CLI/runtime skeleton.

It supports:

- local project initialization
- JSON config under `.thehood/config.json`
- Codex-first default role mapping for orchestrator, implementer, QA, verifier, and critic
- provider and role inspection
- provider and role health inspection
- agent roster inspection showing role ownership, readiness, and read/edit authority
- runtime-derived agent board snapshots and dashboard payloads for Codex card-style agent visibility
- optional repo-local Codex plugin scaffold for TheHood workflow guidance and MCP setup
- runtime-owned team presets for Codex default, ChatGPT Pro orchestration, Claude second-judge, Spark plus Sonnet, Claude builder, and high-assurance Pro plus Claude setups
- configurable budget defaults for max provider iterations and fan-out item caps
- Codex-facing MCP tools for role assignment and guest-agent consultation
- local-only Pro access preflight so Codex can distinguish runtime autopilot, direct bridge readiness, host-policy blocks, and ChatGPT MCP connector handoff paths
- role mapping updates
- run creation for `plan` and `implement`
- approval, rejection, abort, status, and log inspection
- bounded CLI artifact and diff inspection
- hard enforcement that implementer and verifier cannot be the same agent
- a real stdio MCP server exposing TheHood runtime tools
- runtime-owned command log artifacts
- git status/diff evidence capture with protected test-path classification
- runtime-owned integration reports for approved isolated patch application
- runtime-owned final reports for completed runs
- runtime-owned progress packet artifacts for completed runs
- runtime-owned external transfer manifests before repo context or progress packets leave the machine
- GitHub connector-aware repo context routing for clean pushed repos in ChatGPT Web
- user-configurable approval policy with manual, auto-low-risk, and autopilot modes
- separate approval gates when integrated patches touch protected test, fixture, snapshot, or eval paths
- runtime-enforced max iteration limits across resumed runs
- runtime-captured package validation command evidence during verifier review
- runtime-owned review routing artifacts that classify implementation risk before model QA/verifier dispatch
- read-only model-assisted QA tester lane for missed cases and validation suggestions
- runtime-owned critic trigger artifacts when QA, verifier, or validation evidence indicates risk
- runtime-owned revision packet artifacts that route fixable QA, critic, or verifier findings back to the implementer
- provider config merging that preserves newly added built-in models and future-facing model aliases in stale repo-local configs
- deterministic `stub` provider for local loop smoke tests
- `continue` advances runs through orchestrator, implementer, evidence capture, and verifier phases
- `loop` keeps advancing a run until terminal state, manual gate, no progress, or a cycle cap
- schema-bound agent directives and response validation before runtime state advances
- provider response contracts that keep JSON mechanical while long plans, reports, and reviews live in markdown payload fields
- guarded local CLI adapters for Codex CLI and Claude Code
- runtime-owned local agent execution artifacts for Codex CLI and Claude Code command invocations
- bridge-backed ChatGPT Web adapter for ChatGPT Pro orchestration
- provider access-mode metadata for agent bridges, API agents, and MCP connectors
- persistent TheHood Chrome profile manager for the ChatGPT Web bridge
- ChatGPT Web auth and composer readiness checks before bridge calls are marked ready
- branded terminal dashboard shell for runtime, role, and browser readiness
- terminal approval inbox for pending runtime gates
- terminal run monitor for provider wait, approval/transfer gates, and review ownership lanes
- run status insights for latest provider output and final reports
- run status insights for latest progress, reconciliation, repo context, remote repo context, provider execution, final report, and transfer manifest refs
- compact MCP host responses that return refs, counts, latest summaries, and bounded lane/card previews by default instead of dumping full run evidence into the Codex session context
- runtime-derived loop responsibility schedules showing planner, implementer, verifier, runtime QA, QA tester, critic, reconciliation, integration, approval, and completion ownership
- bounded canonical memory refs injected into provider directives so providers rehydrate from runtime state instead of stale chat history
- runtime-captured repo context packs when read-only orchestrators request evidence
- refs-only GitHub connector context when ChatGPT Web can inspect a clean pushed GitHub repo at the current commit
- targeted follow-up repo context packs when a provider delegates concrete new repo paths
- schema-bound planner reconciliation from completed run progress packets
- bounded MCP artifact reads for inspecting guest-agent responses from chat
- read-only MCP repo gateway tools for tree, search, file reads, git status, and git diff

ChatGPT Web is wired through a user-configured bridge command. API provider adapters are not wired to external models yet, though OpenAI and Anthropic API key env names are represented in provider config for future adapters. Local Codex CLI and Claude Code adapters can be selected by role and must return schema-bound responses. Codex CLI discovers live model slugs, while ChatGPT Web and Claude Code expose configured/custom model passthrough so users can select newly available model aliases without waiting for a TheHood release.

Users can choose model owners per role:

```bash
node dist/cli/main.js roles set implementer claude-code:sonnet --repo .
node dist/cli/main.js roles set verifier codex-cli:spark --repo .
node dist/cli/main.js roles set critic claude-code:fable --repo .
node dist/cli/main.js teams apply spark-plus-sonnet --repo .
node dist/cli/main.js teams apply pro-claude-high-assurance --repo .
```

Users can choose between two ChatGPT Pro paths:

- `agent-bridge`: TheHood invokes the ChatGPT Web bridge as an orchestrator or planner.
- `mcp-connector`: ChatGPT connects to TheHood as an MCP connector and uses TheHood's repo/run tools directly.

Both paths keep repo access, approvals, logs, and verification gates owned by the runtime.
For connector mode, generate the local setup guide with `thehood mcp tunnel --tunnel-id <tunnel-id> --profile thehood-local`, keep Secure MCP Tunnel running, and validate from a fresh ChatGPT conversation with `thehood_doctor` plus a read-only repo gateway tool. This is separate from the `chatgpt-web` agent bridge and does not use Chrome/CDP bridge environment variables.
When Codex or a tenant policy blocks a direct external disclosure to ChatGPT Web, that is outside TheHood autopilot. Use `thehood_pro_access` to get the local bridge status and a connector-mode handoff instead of repeating approval prompts.
For broader Claude/Codex/GPT fan-outs, call `thehood_model_access` before the model-backed request. It does not call providers or send repo context; it returns provider readiness, repo visibility, the data boundary, a compact approval packet, and fallback paths. Dirty or unpushed repos ask the user to choose between committing and pushing a checkpoint, approving bounded local context/diff transfer, using no-repo-context strategy, or cancelling. Clean pushed GitHub repos default to remote refs when the provider supports that route, so Codex should not ask the user to type a new long disclosure sentence after a host-policy rejection.

## Quick Start

```bash
npm install
npm run build
npm run smoke:runtime
npm run smoke:mcp
node dist/cli/main.js setup --repo .
node dist/cli/main.js doctor --repo .
node dist/cli/main.js roster --repo .
node dist/cli/main.js agent-board --repo . --artifact --json
```

The full local CLI surface includes:

```bash
node dist/cli/main.js init --repo .
node dist/cli/main.js setup --repo .
node dist/cli/main.js doctor --repo .
node dist/cli/main.js roster --repo .
node dist/cli/main.js agent-board --repo .
node dist/cli/main.js agent-board --repo . --artifact --json
node dist/cli/main.js teams --repo .
node dist/cli/main.js config set fanout-max-items 4 --repo .
node dist/cli/main.js roles --repo .
node dist/cli/main.js goal "Prepare release metadata" --repo . --max-iterations 5
node dist/cli/main.js run "Implement the first provider adapter" --repo .
node dist/cli/main.js run "Exercise the full loop" --repo . --loop
node dist/cli/main.js status --repo .
node dist/cli/main.js agent-board <run-id> --repo .
node dist/cli/main.js artifact <run-id> <artifact-ref> --repo .
node dist/cli/main.js evidence <run-id> --repo .
node dist/cli/main.js continue <run-id> --repo .
node dist/cli/main.js loop <run-id> --repo .
node dist/cli/main.js transfer preview <run-id> --repo .
node dist/cli/main.js approvals policy set mode autopilot --repo .
node dist/cli/main.js ui approvals --repo .
node dist/cli/main.js ui settings --repo .
node dist/cli/main.js ui settings crew --repo .
node dist/cli/main.js ui settings commands --repo .
node dist/cli/main.js config set max-iterations 8 --repo .
node dist/cli/main.js browser status
node dist/cli/main.js ui --repo .
node dist/cli/main.js mcp tunnel --tunnel-id <tunnel-id>
```

The optional Codex plugin lives at `plugins/thehood-codex` and is listed by the repo marketplace at `.agents/plugins/marketplace.json`. It is not installed by default because repo-root Codex custom agents and plugin-provided surfaces should appear only when a user opts into them.

```bash
codex plugin marketplace add /path/to/the-hood
codex plugin add thehood-codex@thehood
```

The plugin expects the `thehood` binary to be available on `PATH` for MCP startup. During local development, use `node dist/cli/main.js mcp config` when you want an absolute-path MCP snippet instead.

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

MCP connector mode
  lets ChatGPT, Codex, or another MCP host call TheHood's runtime and repo tools

Agents
  orchestrator, planner, researcher, implementer, qa tester, verifier, critic, integrator
```

Codex-native Subagents are owned by Codex, not by TheHood MCP tool output. TheHood does not ship repo-root custom agents by default; users can opt into the Codex plugin for TheHood workflow guidance and MCP wiring. TheHood runtime-owned provider calls surface through run status, artifacts, MCP, CLI, TUI, and the agent board.

## Foundation Rules

- The implementer and verifier must not be the same agent.
- The verifier does not get edit tools.
- The QA tester does not get edit tools and cannot satisfy runtime validation gates.
- Runtime-captured logs are the source of truth, not model summaries.
- Model session context is disposable; TheHood preserves exact artifacts and rehydrates providers from runtime state.
- Fixable reviewer findings become runtime revision packets before the implementer gets another pass.
- Test changes require separate classification and review.
- The frontend never owns orchestration logic. It triggers runtime actions.
- Provider choice is user-controlled per role.
- The runtime should be useful headless before it gets a polished UI.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Codex Setup](docs/CODEX_SETUP.md)
- [Runtime Loop](docs/RUNTIME_LOOP.md)
- [Role Contracts](docs/ROLE_CONTRACTS.md)
- [Trust Model](docs/TRUST_MODEL.md)
- [Provider Matrix](docs/PROVIDER_MATRIX.md)
- [Known Limitations](docs/KNOWN_LIMITATIONS.md)
- [Goal, Loop, Schedule](docs/GOAL_LOOP_SCHEDULE.md)
- [Completion Contract](docs/COMPLETION_CONTRACT.md)
- [Loop Recipes](docs/LOOP_RECIPES.md)
- [Synthetic Stub Demo](docs/DEMO.md)
- [Prompt Schemas](docs/PROMPT_SCHEMAS.md)
- [Memory And Reconciliation](docs/MEMORY_AND_RECONCILIATION.md)
- [CLI Spec](docs/CLI_SPEC.md)
- [MCP Spec](docs/MCP_SPEC.md)
- [Provider Adapters](docs/PROVIDER_ADAPTERS.md)
- [Testing And Verification](docs/TESTING_AND_VERIFICATION.md)
- [Security And Privacy](docs/SECURITY_AND_PRIVACY.md)
- [Product Strategy](docs/product/README.md)
- [Model Selection](docs/product/model-selection.md)
- [Research Notes](docs/RESEARCH_NOTES.md)
- [Roadmap](docs/ROADMAP.md)
- [Glossary](docs/GLOSSARY.md)
- [Licensing](docs/LICENSING.md)
- [Open Decisions](docs/OPEN_DECISIONS.md)
- [Public Repo Readiness](docs/PUBLIC_REPO_READINESS.md)
- [v0.1.0-preview.0 Release Notes](docs/release/v0.1.0-preview.0.md)

## Public Repo Docs

- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Agent Instructions](AGENTS.md)

## Decisions

- [0001: Runtime First With CLI And MCP](docs/decisions/0001-runtime-first-cli-and-mcp.md)
- [0002: Provider Neutral Role Mapping](docs/decisions/0002-provider-neutral-role-mapping.md)
- [0003: Separate Implementation And Verification](docs/decisions/0003-separate-implementation-and-verification.md)
