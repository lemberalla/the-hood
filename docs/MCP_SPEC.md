# MCP Spec

The MCP server exposes TheHood to Codex and other MCP clients.

Codex should use MCP as the doorway into the runtime. MCP tools should not implement orchestration logic themselves.

## Server

```bash
thehood mcp
```

The current implementation uses the MCP stdio transport: newline-delimited JSON-RPC messages over stdin/stdout. It implements initialization, `tools/list`, `tools/call`, and `ping`.

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

## Tools

Implemented tools:

- `thehood_plan`
- `thehood_orchestrate`
- `thehood_continue`
- `thehood_status`
- `thehood_abort`

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
  "next_actions": ["string"]
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
    "implementer": "provider:model",
    "verifier": "provider:model",
    "critic": "provider:model"
  },
  "constraints": ["string"]
}
```

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
      "kind": "plan | diff | log | report",
      "ref": "string"
    }
  ]
}
```

### `thehood_continue`

Continue a paused run.

Input:

```json
{
  "run_id": "string",
  "approval": "approve | reject | revise | none",
  "message": "string"
}
```

### `thehood_status`

Inspect a run.

Input:

```json
{
  "run_id": "string"
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
- Large logs and diffs are artifacts, not giant inline payloads.
- Tool outputs include approval state.
- MCP tools do not bypass CLI/runtime policies.
- MCP tools never expose secrets.
