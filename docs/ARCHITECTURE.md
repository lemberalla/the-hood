# Architecture

TheHood is a local orchestration runtime. It coordinates multiple model providers and agent tools while keeping authority in deterministic local code.

The runtime is the product core. The CLI, MCP server, and macOS menubar app are control surfaces over that same runtime.

## Goals

- Let users choose which model performs each role.
- Run agent loops with explicit state, permissions, logs, and approval gates.
- Support Codex through MCP without making Codex responsible for orchestration safety.
- Support ChatGPT Pro as an orchestrator through a user-authenticated adapter.
- Support Claude, GPT, Codex, Claude Code, and local models as interchangeable role participants.
- Keep verification independent from implementation.
- Make runs inspectable and reproducible enough for public, trusted use.

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
  verifier:
    provider: anthropic-api
    model: claude-opus
  critic:
    provider: anthropic-api
    model: claude-sonnet
```

### Agent Contracts

Each role has a schema-bound contract:

- input variables
- allowed tools
- disallowed tools
- output schema
- done definition
- evidence requirements

The runtime validates structured outputs before acting on them.

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

