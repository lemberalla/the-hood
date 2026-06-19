# Architecture

TheHood is a local orchestration runtime. It coordinates multiple model providers and agent tools while keeping authority in deterministic local code.

The runtime is the product core. The CLI, MCP server, and macOS menubar app are control surfaces over that same runtime.

## Goals

- Let users choose which model performs each role.
- Run agent loops with explicit state, permissions, logs, and approval gates.
- Support Codex through MCP without making Codex responsible for orchestration safety.
- Support ChatGPT Pro as an orchestrator through a user-authenticated adapter.
- Support ChatGPT Pro as an MCP connector client that can inspect local repo state through TheHood tools.
- Support Claude, GPT, Codex, Claude Code, and local models as interchangeable role participants.
- Keep verification independent from implementation.
- Make runs inspectable and reproducible enough for public, trusted use.
- Make provider session context disposable by preserving canonical runtime memory and rehydrating models from exact artifacts.

## Non-Goals

- Do not bypass provider access controls, quotas, or subscriptions.
- Do not scrape hidden chain-of-thought.
- Do not let browser automation become the source of authority.
- Do not make the macOS app own orchestration logic.
- Do not merge agent output without runtime and user approval gates.

## System Diagram

```text
                       +----------------------+
                       |        Codex         |
                       |  MCP client/cockpit  |
                       +----------+-----------+
                                  |
                                  | MCP tools
                                  v
+-------------+        +----------+-----------+        +------------------+
|     CLI     +------->|     TheHood MCP      +------->|  Local runtime   |
| control     |        |       server         |        | state machine    |
+------+------+        +----------------------+        +---+----------+---+
       |                                                    |          |
       | local API                                          |          |
       v                                                    v          v
+------+-------+                                    +-------+--+   +---+------+
| macOS menu   |                                    | Worktree |   | Logs     |
| trigger UI   |                                    | manager  |   | store    |
+--------------+                                    +----------+   +----------+
                                                            |
                                                            v
       +-------------------+-------------------+-------------+-------------+
       |                   |                   |                           |
       v                   v                   v                           v
+------+-------+   +-------+------+   +--------+-------+          +--------+------+
| ChatGPT Pro  |   | OpenAI API   |   | Anthropic API  |          | CLI agents    |
| adapter      |   | adapter      |   | adapter        |          | Codex/Claude  |
+--------------+   +--------------+   +----------------+          +---------------+
```

## Runtime Components

### Run Store

Persists every run and its state transitions.

Minimum data:

- `run_id`
- `repo_path`
- `user_goal`
- `mode`
- `role_mapping`
- `state`
- `iterations`
- `approval_events`
- `tool_events`
- `diff_snapshots`
- `test_logs`
- `final_report`

### State Machine

Owns the loop. It decides which stage comes next based on structured outputs, test results, approval state, and stop conditions.

Expected states:

- `created`
- `planning`
- `awaiting_approval`
- `delegating`
- `implementing`
- `verifying`
- `critiquing`
- `integrating`
- `completed`
- `failed`
- `aborted`

### Permission Manager

Enforces role permissions before tools run.

Examples:

- Verifier cannot edit.
- Critic cannot edit.
- QA tester cannot edit.
- Researcher cannot edit.
- Implementer can edit only allowed paths.
- Integrator can apply approved patches.
- Test files are protected unless the run explicitly allows test changes.

### Tool Runner

Executes deterministic commands and captures raw logs.

The runner is responsible for:

- command execution
- timeout handling
- exit code capture
- stdout and stderr capture
- environment redaction
- artifact storage

### Memory Store

Preserves canonical project memory as exact run records, events, approvals, provider directives, provider responses, diffs, command logs, validation results, verifier verdicts, final reports, and reconciliation artifacts.

Index and retrieval layers can make memory searchable, but they are derived from canonical artifacts. If an index, reflection, or summary disagrees with a source artifact, the artifact wins.

### Worktree Manager

Keeps implementer work isolated from the user's active checkout when possible.

Responsibilities:

- create scoped worktrees
- capture diffs
- detect dirty state
- prevent accidental unrelated reversions
- apply approved changes back to the target checkout

### Provider Router

Maps role requests to provider adapters.

Example:

```yaml
roles:
  orchestrator:
    provider: chatgpt-web
    model: chatgpt-pro
  implementer:
    provider: codex-cli
    model: gpt-5.5-low
  qa:
    provider: codex-cli
    model: spark
  verifier:
    provider: claude-code
    model: default
  critic:
    provider: claude-code
    model: default
```

Providers can expose multiple access modes:

| Mode | Meaning |
| --- | --- |
| `agent-bridge` | TheHood invokes a provider adapter or local agent command. |
| `api-agent` | TheHood invokes an API model and can mediate tool calls. |
| `mcp-connector` | An external MCP host such as ChatGPT connects to TheHood and calls runtime tools. |

The runtime contract is the same regardless of access mode. The mode changes the transport and who initiates the model call, not who owns permissions, repo access, approvals, logs, or verification.

Repo-local config overlays must not hide newly added built-in provider models or access modes. The runtime merges built-in provider definitions with `.thehood/config.json` so stale local configs can keep user choices while still seeing new built-in capabilities such as `codex-cli:spark` and `stub:qa`.

Same-run summons use the same provider router and role contracts. CLI and MCP can request a read-only planner, researcher, QA tester, verifier, or critic with a brief and optional one-call provider assignment, but the runtime still builds the directive, records the handoff, enforces approval gates, validates the response, and stores artifacts on the run.

### Agent Contracts

Each role has a schema-bound contract:

- input variables
- allowed tools
- disallowed tools
- output schema
- done definition
- evidence requirements

The runtime validates structured outputs before acting on them.

The QA tester contract is advisory. It can inspect runtime evidence, call out missed cases, and recommend deterministic validation, but only runtime-captured command evidence can satisfy the runtime QA/validation lane.

The critic contract is also advisory. Automatic critic calls are initiated by runtime policy from structured QA, verifier, and validation evidence and are recorded as `critic_trigger` artifacts.

When QA, critic, or verifier evidence contains a fixable revision finding, the runtime can write a compact `revision_packet` artifact and delegate a repair pass back to the implementer. The packet carries refs, reason code, repair objective, and acceptance criteria; it does not give reviewers edit tools or let the implementer self-verify.

### Rehydration And Reconciliation

Before calling a model provider, the runtime can build a bounded context packet from canonical memory. The packet includes exact refs and selected excerpts so a provider can reason without relying on browser or API session history.

After implementation and verification, the runtime can send an approved progress packet back to the planner or orchestrator for reconciliation. The provider may update its plan state or recommend the next slice, but the runtime still owns approvals, evidence, and state transitions.

## Control Surfaces

### CLI

The CLI is the first-class control plane.

It should support:

- setup
- role configuration
- run creation
- approvals
- status
- logs
- abort/resume
- MCP server startup

### MCP Server

The MCP server exposes runtime actions to Codex.

Codex should call the MCP tools, then the runtime does the actual orchestration.

The same MCP surface can also be used by ChatGPT Developer Mode through a connector or Secure MCP Tunnel. In that mode, ChatGPT is the MCP host, TheHood is the repo/runtime gateway, and TheHood returns exact bounded tool results such as file reads, search matches, git status, diffs, run status, and artifacts.

### macOS Menubar App

The menubar app is a thin companion.

It can:

- show active runs
- approve or reject next steps
- pause and resume
- swap role mappings
- open logs and diffs
- trigger common workflows

It must not:

- own agent state
- own orchestration decisions
- bypass runtime permissions
- execute tools directly

## Authority Model

TheHood separates suggestion, execution, and acceptance:

```text
Model proposes plan or action
Runtime validates schema and permissions
Runtime executes deterministic tools
Verifier inspects evidence without edit power
User approves sensitive transitions
Runtime integrates approved output
```

No model should be trusted as the only source of truth for its own work.
