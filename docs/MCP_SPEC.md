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
- `thehood_model_access`
- `thehood_pro_access`
- `thehood_agent_board`
- `thehood_assign_roles`
- `thehood_plan`
- `thehood_orchestrate`
- `thehood_consult`
- `thehood_summon`
- `thehood_fanout`
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
The output includes `runtime.capabilities` so Codex can detect stale MCP server processes after local development builds. Provider entries include model policy, such as `listed`, `discovered`, or `passthrough`, so Codex can tell whether a model name came from a fixed list, a live catalog, or a user-configured provider passthrough.

Input:

```json
{
  "repo_path": "string"
}
```

### `thehood_roles`

Inspect configured role assignments, health, and the full agent roster. The roster is derived from the same runtime role contracts and includes lane labels, provider:model owners, default-vs-repo assignment source, readiness, purpose, and read/edit/shell/network authority. It is display and configuration metadata only; it does not grant permissions or schedule work.

Input:

```json
{
  "repo_path": "string"
}
```

### `thehood_model_access`

Inspect a general external model-access path without calling providers or sending repo context. Use this before Claude/Codex/GPT/Pro consults, fan-outs, or orchestrations that may disclose repo context, progress packets, memory, or runtime artifacts outside the local TheHood runtime.

Input:

```json
{
  "repo_path": "string",
  "agents": ["claude-code:opus", "codex-cli:gpt-5.5"],
  "purpose": "optional local-only purpose",
  "context_kind": "repo_context | progress_packet | no_repo_context | connector_handoff",
  "constraints": ["optional local-only constraints"]
}
```

Output includes current TheHood approval policy, provider/model readiness, repo visibility, a data-boundary summary, an explicit note that Codex or tenant external-disclosure policy is outside TheHood runtime control, a compact approval packet, and fallback paths such as no-repo-context prompting, connector mode when supported, or runtime-only evidence inspection. When Codex needs the user to approve the packet, render `approval_packet.copyable_text_block` as a fenced `text` block so the user gets a native copy button instead of inline approval prose.

Repo visibility drives the default UX:

- Dirty or unpushed repos require a user choice: commit and push a checkpoint first, approve bounded local context or diff transfer, use no-repo-context strategy, or cancel.
- Clean pushed GitHub repos default to remote refs when the provider supports that route. For `chatgpt-web`, TheHood should prefer ChatGPT's GitHub connector at the exact commit instead of sending local file contents through Codex.

If Codex rejects a direct model-backed call as an external disclosure, do not ask the user to type a fresh long approval phrase. Present the model-access approval packet, show the exact approval text in a fenced `text` block if the user accepts, or switch to no-repo-context or connector mode.

### `thehood_pro_access`

Inspect the ChatGPT Pro access path without calling Pro or sending repo context externally. This is the safe fallback when Codex host policy rejects a direct `chatgpt-web` consult before TheHood can apply runtime autopilot.

Input:

```json
{
  "repo_path": "string",
  "goal": "optional local-only handoff goal",
  "constraints": ["optional local-only handoff constraints"]
}
```

Output includes current TheHood approval policy, ChatGPT Web bridge readiness, an explicit note that Codex or tenant external-disclosure policy is outside TheHood runtime control, and recommended paths for ChatGPT MCP connector mode, direct Codex agent-bridge mode, or an abstract no-repo-context Pro prompt.

If Codex rejects a direct Pro consult as an external disclosure, do not ask the user to approve the same blocked action again. Call `thehood_pro_access`, then use connector mode or a no-repo-context prompt.

### `thehood_agent_board`

Return a visual-ready agent board for Codex app card-style visibility. The board is derived from role config, provider health, crew lanes, review lanes, loop responsibilities, handoffs, artifacts, and operator next actions. It is display guidance only: it does not grant tools, schedule agents, satisfy gates, or approve work.

Input:

```json
{
  "repo_path": "string",
  "run_id": "optional string",
  "include_artifact": "optional boolean"
}
```

When `run_id` is omitted, the board is repo-scoped and shows configured agents, readiness, owners, and authority. When `run_id` is present, cards also include current lane state, blocking state, sidecar status, and bounded artifact/event/handoff refs for that run. When `include_artifact` is true, the output also includes `artifact.surface`, `artifact.manifest`, and `artifact.snapshot`, a bounded dashboard payload that a Codex app artifact renderer can display as native card and table UI.

This MCP tool does not create Codex-native subagent threads. Use the optional TheHood Codex plugin only when the user wants TheHood guidance and MCP wiring loaded into Codex; native Codex subagent threads still require Codex-owned subagent workflows.

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
    "qa": "provider:model",
    "verifier": "provider:model",
    "critic": "provider:model"
  }
}
```

Examples:

```json
{
  "repo_path": "/path/to/repo",
  "role_mapping": {
    "implementer": "claude-code:sonnet",
    "qa": "codex-cli:spark",
    "verifier": "claude-code:sonnet",
    "critic": "claude-code:fable"
  }
}
```

```json
{
  "repo_path": "/path/to/repo",
  "role_mapping": {
    "orchestrator": "chatgpt-web:chatgpt-pro",
    "implementer": "codex-cli:default",
    "verifier": "claude-code:sonnet",
    "critic": "claude-code:sonnet"
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
  "constraints": ["string"],
  "auto_loop": "optional boolean",
  "max_cycles": "optional positive integer for auto_loop",
  "max_steps_per_cycle": "optional positive integer for auto_loop"
}
```

When `auto_loop` is true, the created plan run is immediately advanced through the headless loop runner until terminal state, required manual approval, no progress, or the cycle cap.

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
    "qa": "provider:model",
    "verifier": "provider:model",
    "critic": "provider:model"
  },
  "constraints": ["string"],
  "auto_loop": "optional boolean",
  "max_cycles": "optional positive integer for auto_loop",
  "max_steps_per_cycle": "optional positive integer for auto_loop"
}
```

When `auto_loop` is true, the created run is immediately advanced through the headless loop runner. Manual gates are still not approved by this flag; runtime autopilot policy may auto-approve bounded gates when configured.

### `thehood_consult`

Run one read-only guest role immediately. This is the fast path for Codex chat to bring in Codex Spark, Pro, Claude, or another agent for planning, research, QA, second judgment, or critique.

Input:

```json
{
  "goal": "string",
  "repo_path": "string",
  "role": "orchestrator | planner | researcher | qa | critic",
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
  "agent": "codex-cli:spark"
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

QA tester example:

```json
{
  "goal": "Inspect the current implementation evidence and recommend missed validation cases.",
  "repo_path": "/path/to/repo",
  "role": "qa",
  "agent": "codex-cli:spark"
}
```

Claude second-judge example:

```json
{
  "goal": "Challenge the current implementation plan and call out risks before we build.",
  "repo_path": "/path/to/repo",
  "role": "critic",
  "agent": "claude-code:sonnet"
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
      "kind": "plan | diff | log | report | metadata | status | agent | directive | context | remote_context | progress | reconciliation | critic_trigger | revision_packet | fanout | transfer_manifest",
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
  "role": "orchestrator | planner | researcher | qa | verifier | critic",
  "brief": "string",
  "agent": "optional provider:model",
  "kind": "optional review | qa | critique | research | plan",
  "persona": "optional short role brief",
  "constraints": ["string"],
  "evidence_refs": ["artifact ref"]
}
```

The runtime records `agent_summoned`, a typed handoff, and provider directive/response artifacts when the provider runs. A one-call `agent` override does not rewrite the run's role mapping. Model-backed providers still pass through the provider-invocation approval gate; autopilot may auto-approve that bounded gate according to policy. A `qa` summon records model-assisted tester evidence, but runtime-captured validation artifacts remain the proof for runtime QA/validation gates.

Output includes the run summary, summoned role, summoned agent, summon kind, stop reason, directive and response artifact refs when present, provider response count, and normalized provider response summaries. Long provider-authored plans, reports, reviews, and critique should be returned as markdown in the role payload and are bounded in tool responses.

### `thehood_fanout`

Run a bounded group of read-only same-run summons on an existing run. This is the MCP path for asking several advisory agents to inspect the same state, such as QA tester plus critic, without giving those agents edit authority or acceptance authority.

Input:

```json
{
  "run_id": "string",
  "repo_path": "string",
  "max_items": "optional number, hard-capped at 8",
  "items": [
    {
      "role": "orchestrator | planner | researcher | qa | verifier | critic",
      "brief": "string",
      "agent": "optional provider:model",
      "kind": "optional summon kind",
      "persona": "optional string",
      "constraints": ["string"],
      "evidence_refs": ["artifact ref"]
    }
  ]
}
```

Output includes the run summary, `fanout_status`, bounds, the compact `fanout` artifact ref, and one item summary per attempted summon with role, summon kind, status, stop reason, agent, directive artifact, response artifact, and provider status when present. Execution is currently sequential. Repo config `defaults.fanoutMaxItems` can lower the item cap, while the runtime hard cap remains 8. If a provider invocation or transfer gate blocks one item, the runtime stops before later items and records the group artifact. If a read-only advisory item returns malformed output or another contained provider failure without opening a gate, the runtime records that item as blocked or failed and continues to later requested items. Fan-out evidence is sidecar-only; it may appear in QA tester or critic lanes, but it cannot satisfy required verifier, runtime QA, approval, or completion gates.

### `thehood_continue`

Continue a paused or ready run through the runtime.

Current behavior:

- uses `approval: "none"` when no manual approval gate is active
- optionally records an explicit approval decision for an active manual gate
- advances the runtime loop until completion or the next gate
- may auto-approve bounded gates under runtime autopilot policy, including provider invocation and non-secret external transfers, while recording `approval_auto_approved` evidence
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

### `thehood_loop`

Run an existing TheHood run through the headless autopilot runner.

Current behavior:

- repeatedly calls the runtime advance path
- stops on terminal state, required manual approval, no progress, or max cycle cap
- does not approve manual gates
- still lets runtime autopilot policy auto-approve bounded gates when configured
- returns the final run state, stop kind, stop reason, cycle log, provider response count, normalized provider responses, and structured `next_actions`

Input:

```json
{
  "run_id": "string",
  "repo_path": "string",
  "max_cycles": "optional positive integer, default 8",
  "max_steps_per_cycle": "optional positive integer, default 10"
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

Output is compact by default. It includes run state, role mapping, artifact/event/tool counts, latest artifact refs, recent events, compact `next_actions`, compact `agent_board`, and bounded `insights`. The compact response is designed for MCP hosts such as Codex so repeated status checks do not fill the conversation context with full run evidence. Full evidence remains in `.thehood` run records and artifacts.

Set `detail` to `full` only when the caller intentionally needs the legacy verbose payload. Prefer reading a specific artifact with `thehood_read_artifact` when inspecting plans, verifier reports, provider logs, progress packets, or fan-out evidence.

Compact insights expose the latest attached provider response artifact, parsed primary output such as `decision`, final report artifact, latest progress packet, reconciliation, repo context, remote repo context, local provider execution, review routing, critic trigger, revision packet, fan-out, and transfer manifest refs when present, plus refs-only `canonicalMemory`, bounded revision trails, crew lane trails, review lanes, loop responsibility schedules, and operator next actions. Revision trails, crew lanes, loop responsibilities, and agent board cards are derived by the runtime from canonical run evidence and are display guidance only; they do not grant tools or satisfy verifier/runtime QA gates.

Input:

```json
{
  "run_id": "string",
  "repo_path": "string",
  "detail": "summary | full"
}
```

### `thehood_runs`

List recent runs for a repository.

Input:

```json
{
  "repo_path": "string",
  "limit": 20,
  "detail": "summary | full"
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
- Runtime tool responses are compact by default; use `detail: "full"` sparingly and prefer artifact reads for exact evidence.
- Tool outputs include approval state.
- MCP tools do not bypass CLI/runtime policies.
- MCP tools never expose secrets.

## Codex Chat Flow

Recommended flow inside a Codex chat:

1. Call `thehood_doctor` to check available provider adapters and local CLI commands.
2. Call `thehood_model_access` before Claude/Codex/GPT/Pro consults, fan-outs, or orchestrations that may disclose repo context, progress packets, memory, or runtime artifacts. If the repo is dirty or unpushed, present the user choices from the preflight. If the repo is clean and pushed, use the remote GitHub refs default when the provider supports it. If host policy rejects a direct call, present the compact approval packet with `approval_packet.copyable_text_block` as a fenced `text` block, or switch to no-repo-context or connector mode.
3. Call `thehood_pro_access` before a direct `chatgpt-web` consult when the user asks for Pro from Codex and ChatGPT Web bridge readiness or ChatGPT MCP connector handoff details matter.
4. Call `thehood_assign_roles` when the user wants persistent role ownership, such as Pro as orchestrator, Claude as critic/verifier, Claude as implementer, or Spark plus Sonnet role separation.
5. Call `thehood_consult`, `thehood_summon`, or `thehood_fanout` to bring in read-only agents such as a critic, QA tester, or Claude second judge; use `thehood_continue` with `approval: "none"` when no manual approval gate is active so runtime autopilot can auto-approve bounded provider gates when policy allows.
6. Call `thehood_orchestrate` for implementation runs that require approval and verifier separation.
7. Call `thehood_continue` with `approval: "approve"`, `approval: "reject"`, or `approval: "revise"` only for an active manual approval gate after the user authorizes that gate.
