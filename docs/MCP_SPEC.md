# MCP Spec

The MCP server exposes TheHood to Codex, ChatGPT Developer Mode, and other MCP clients.

Codex should use MCP as the doorway into the runtime. MCP tools should not implement orchestration logic themselves.

## Server

```bash
thehood mcp
```

The current implementation uses the MCP stdio transport: newline-delimited JSON-RPC messages over stdin/stdout. It implements initialization, `tools/list`, `tools/call`, and `ping`.

For ChatGPT Web, use ChatGPT Developer Mode with an MCP connector. For private local repos, prefer OpenAI Secure MCP Tunnel pointing at the stdio command:

```bash
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile thehood-local \
  --tunnel-id <tunnel-id> \
  --mcp-command "thehood mcp"

tunnel-client doctor --profile thehood-local --explain
tunnel-client run --profile thehood-local
```

Then create a ChatGPT connector using the tunnel connection and enable it in a new conversation. In that mode, ChatGPT can call TheHood's exact repo and run tools instead of receiving a prebuilt summary.

The CLI can print the same tunnel setup shape:

```bash
thehood mcp tunnel --tunnel-id <tunnel-id> --profile thehood-local
node dist/cli/main.js mcp tunnel --tunnel-id <tunnel-id> --profile thehood-local
```

Use the local-build command while developing TheHood so the tunnel points at the current checkout's `dist/cli/main.js`.

References:

- [MCP Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP Lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
- [MCP Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

Conceptual Codex config:

```toml
[mcp_servers.thehood]
command = "thehood"
args = ["mcp"]
```

Run `thehood mcp config` or `node dist/cli/main.js mcp config` to print installed-package and local-build snippets.

Run `thehood mcp config --chatgpt-web` after launching a debug Chrome profile and selecting the intended ChatGPT model to print snippets with the ChatGPT Web bridge environment variables included.

## Tools

Implemented tools:

- `thehood_doctor`
- `thehood_roles`
- `thehood_assign_roles`
- `thehood_plan`
- `thehood_orchestrate`
- `thehood_consult`
- `thehood_summon`
- `thehood_continue`
- `thehood_reconcile`
- `thehood_status`
- `thehood_runs`
- `thehood_read_artifact`
- `thehood_capture_evidence`
- `thehood_repo_tree`
- `thehood_repo_search`
- `thehood_repo_read_file`
- `thehood_git_status`
- `thehood_git_diff`
- `thehood_abort`

### `thehood_doctor`

Inspect provider and role readiness without invoking model calls.
The output includes `runtime.capabilities` so Codex can detect stale MCP server processes after local development builds.

Input:

```json
{
  "repo_path": "string"
}
```

### `thehood_roles`

Inspect configured role assignments and health.

Input:

```json
{
  "repo_path": "string"
}
```

### `thehood_assign_roles`

Persist provider:model assignments for one or more roles.

Input:

```json
{
  "repo_path": "string",
  "role_mapping": {
    "orchestrator": "provider:model",
    "planner": "provider:model",
    "researcher": "provider:model",
    "implementer": "provider:model",
    "verifier": "provider:model",
    "critic": "provider:model"
  }
}
```

### `thehood_plan`

Create a read-only plan.

Input:

```json
{
  "goal": "string",
  "repo_path": "string",
  "orchestrator": "optional provider:model",
  "constraints": ["string"]
}
```

Output:

```json
{
  "run_id": "string",
  "status": "awaiting_approval | completed | failed",
  "plan": "string",
  "next_actions": [
    {
      "action": "string",
      "label": "string",
      "description": "string",
      "owner": {
        "kind": "runtime | role",
        "label": "string",
        "role": "optional runtime role"
      },
      "blocking": "boolean",
      "required": "boolean",
      "tool": "optional MCP tool name",
      "arguments": "optional tool arguments",
      "artifactRefs": ["string"],
      "eventRefs": ["string"]
    }
  ]
}
```

### `thehood_orchestrate`

Start or continue a full run.

Input:

```json
{
  "goal": "string",
  "repo_path": "string",
  "mode": "plan | research | implement | review",
  "role_mapping": {
    "orchestrator": "provider:model",
    "planner": "provider:model",
    "researcher": "provider:model",
    "implementer": "provider:model",
    "verifier": "provider:model",
    "critic": "provider:model"
  },
  "constraints": ["string"]
}
```

### `thehood_consult`

Run one read-only guest role immediately. This is the fast path for Codex chat to bring in Claude or another agent for planning, research, or critique.

Input:

```json
{
  "goal": "string",
  "repo_path": "string",
  "role": "orchestrator | planner | researcher | critic",
  "agent": "provider:model",
  "constraints": ["string"]
}
```

Example:

```json
{
  "goal": "Critique the current approach before implementation.",
  "repo_path": "/path/to/repo",
  "role": "critic",
  "agent": "claude-code:opus"
}
```

ChatGPT Pro example:

```json
{
  "goal": "Plan the implementation and delegate safely.",
  "repo_path": "/path/to/repo",
  "role": "orchestrator",
  "agent": "chatgpt-web:chatgpt-pro"
}
```

`chatgpt-web` requires `THEHOOD_CHATGPT_WEB_COMMAND`; without it the run returns `blocked`.

Output includes the created run id, current or final state, consulted role, consulted agent, stop reason, provider response count, normalized provider response summaries, and artifacts. Provider response summaries keep markdown payloads bounded; read the response artifact for the complete markdown plan, report, review, or critique. Read-only model-backed guest agents may return `awaiting_approval` before the first provider call; continue only after the user approves invoking that provider.

Output:

```json
{
  "run_id": "string",
  "status": "created | planning | awaiting_approval | implementing | verifying | completed | failed",
  "summary": "string",
  "approval_required": true,
  "approval_reason": "string",
  "artifacts": [
    {
      "kind": "plan | diff | log | report | metadata | status | agent | directive | context | progress | reconciliation | transfer_manifest",
      "ref": "string"
    }
  ]
}
```

### `thehood_summon`

Summon a read-only role onto an existing run. This is the same-run path for planner, reviewer, QA, research, and critic work when the response should be attached to the active run instead of a separate consult run.

Input:

```json
{
  "run_id": "string",
  "repo_path": "string",
  "role": "orchestrator | planner | researcher | verifier | critic",
  "brief": "string",
  "agent": "optional provider:model",
  "kind": "optional review | qa | critique | research | plan",
  "persona": "optional short role brief",
  "constraints": ["string"],
  "evidence_refs": ["artifact ref"]
}
```

The runtime records `agent_summoned`, a typed handoff, and provider directive/response artifacts when the provider runs. A one-call `agent` override does not rewrite the run's role mapping. Model-backed providers still pass through the provider-invocation approval gate; autopilot may auto-approve that bounded gate according to policy.

Output includes the run summary, summoned role, summoned agent, summon kind, stop reason, directive and response artifact refs when present, provider response count, and normalized provider response summaries. Long provider-authored plans, reports, reviews, and critique should be returned as markdown in the role payload and are bounded in tool responses.

### `thehood_continue`

Continue a paused run.

Current behavior:

- optionally records an approval decision
- advances the runtime loop until completion or the next gate
- returns the final state, stop reason, provider response count, normalized provider responses, and structured `next_actions`
- `next_actions` are derived by the runtime, include bounded owner/blocking/required metadata, and are display guidance for MCP clients rather than policy grants
- approval gates include `thehood_read_artifact` next actions when a specific patch, integration report, or transfer manifest should be inspected first
- external provider transfer gates include `thehood_transfer_preview` next actions when a transfer manifest is available
- completed runs include an `inspect_final_report` next action when a final report artifact is available
- completed runs include a `thehood_reconcile` next action when they can be reconciled from a progress packet

Input:

```json
{
  "run_id": "string",
  "approval": "approve | reject | revise | none",
  "message": "string"
}
```

### `thehood_reconcile`

Reconcile a completed run from its latest progress packet.

Current behavior:

- finds or creates a `progress` artifact for a completed run
- writes a `transfer_manifest` artifact and pauses for approval before sending progress packets to browser or API providers
- invokes the configured `planner`, or `orchestrator` when no planner is assigned
- stores the schema-bound provider response as a `reconciliation` artifact whose role payload may include markdown narrative

Input:

```json
{
  "run_id": "string",
  "repo_path": "string",
  "role": "optional planner | orchestrator",
  "approval": "approve | reject | revise | none",
  "message": "optional approval message"
}
```

### `thehood_transfer_preview`

Read the latest external transfer manifest for a run without sending anything to a provider.

Use this before approving browser or API-provider transfer gates.

Input:

```json
{
  "run_id": "string",
  "repo_path": "string"
}
```

### `thehood_status`

Inspect a run.

Output includes run fields, events, runtime-derived `next_actions`, and `insights`. Insights expose the latest attached provider response artifact, parsed primary output such as `decision`, final report artifact, latest progress packet, reconciliation, repo context, and transfer manifest refs when present, plus bounded refs-only `canonicalMemory`, review lanes, loop responsibility schedules, and operator next actions, so Codex can show completed Pro state without manually reading artifacts first. Loop responsibilities are derived by the runtime from canonical run evidence and are display guidance only; they do not grant tools or satisfy verifier/QA gates.

Input:

```json
{
  "run_id": "string"
}
```

### `thehood_runs`

List recent runs for a repository.

Input:

```json
{
  "repo_path": "string",
  "limit": 20
}
```

### `thehood_read_artifact`

Read a bounded artifact attached to a run. The runtime only allows refs already recorded on that run and only inside that run's artifact directory.

Input:

```json
{
  "run_id": "string",
  "repo_path": "string",
  "ref": "string",
  "max_bytes": 20000
}
```

### Repo Gateway Tools

The repo gateway tools are read-only and bounded. They skip `.git`, `.thehood`, dependency/build output, and secret-looking paths.

`thehood_repo_tree`:

```json
{
  "repo_path": "string",
  "path": "optional relative directory",
  "max_depth": 4,
  "max_entries": 200
}
```

`thehood_repo_search`:

```json
{
  "repo_path": "string",
  "query": "string",
  "globs": ["src/**/*.ts"],
  "max_results": 50,
  "case_sensitive": true
}
```

`thehood_repo_read_file`:

```json
{
  "repo_path": "string",
  "path": "relative file path",
  "offset": 0,
  "max_bytes": 20000
}
```

`thehood_git_status`:

```json
{
  "repo_path": "string"
}
```

`thehood_git_diff`:

```json
{
  "repo_path": "string",
  "path": "optional relative file path",
  "max_bytes": 20000
}
```

### `thehood_abort`

Abort a run.

Input:

```json
{
  "run_id": "string",
  "reason": "string"
}
```

## Tool Design Rules

- Tools return run references and compact summaries.
- Large logs, diffs, and repo context packs are artifacts, not giant inline payloads.
- Tool outputs include approval state.
- MCP tools do not bypass CLI/runtime policies.
- MCP tools never expose secrets.

## Codex Chat Flow

Recommended flow inside a Codex chat:

1. Call `thehood_doctor` to check available provider adapters and local CLI commands.
2. Call `thehood_assign_roles` when the user wants persistent role ownership, such as Claude as critic or verifier.
3. Call `thehood_consult` to bring in a guest read-only agent; approve the provider-invocation gate before Claude, Codex, or Pro is actually called.
4. Call `thehood_orchestrate` for implementation runs that require approval and verifier separation.
5. Call `thehood_continue` with approval only after the user authorizes the next runtime transition.
