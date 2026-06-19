# Provider Adapters

Provider adapters connect role contracts to concrete model or agent systems.

Adapters translate TheHood's structured role requests into provider-specific calls, then normalize the result back into TheHood schemas.

## Provider Access Modes

TheHood tracks provider access modes so users can choose the transport that fits their workflow:

| Mode | Owner of model call | Best for |
| --- | --- | --- |
| `agent-bridge` | TheHood | Codex-first loops, local CLI agents, ChatGPT Web/CDP bridge orchestration |
| `api-agent` | TheHood | API models with structured tool calls and traceable runtime mediation |
| `mcp-connector` | External MCP host | ChatGPT Developer Mode or another MCP client inspecting a local repo through TheHood |

Access mode is not an authority boundary. The runtime still owns repo access, permissions, approvals, artifacts, patch integration, and verification gates.

`chatgpt-web` supports both `agent-bridge` and `mcp-connector` paths. The agent bridge sends a runtime directive to the ChatGPT Web bridge. MCP connector mode lets ChatGPT call TheHood tools such as repo search, file read, run status, and artifact read through a connector or Secure MCP Tunnel.

## Adapter Interface

Each adapter should support:

```ts
interface ProviderAdapter {
  id: string;
  runAgent(request: AgentRequest): Promise<AgentResponse>;
}
```

Current request shape:

```yaml
agent_request:
  run: RunRecord
  role: orchestrator | planner | researcher | implementer | qa | verifier | critic
  assignment:
    provider: string
    model: string
  context: object
  directive:
    objective: string
    instructions:
      - string
    tool_permissions:
      read: boolean
      edit: boolean
      shell: boolean
      network: boolean
    output_contract:
      schema_version: 1
      name: string
      required_data_key: string
    variables:
      run: object
      role: object
      context: object
```

The runtime writes each directive as a `directive` artifact before provider execution. It validates each provider response against the role output contract before advancing the run state.

`AgentResponse` JSON is the mechanical envelope for runtime control. Role payloads should keep small fields such as `action`, `reason`, `status`, `verdict`, refs, and `thehoodDirectiveAck` as JSON. Human-facing plans, reports, reviews, critique, rationale, acceptance criteria, and other long narrative content should be returned as GitHub-flavored Markdown in `data.<required_data_key>.markdown`. Adapters should avoid asking providers to express long plans as nested JSON arrays or objects.

## Local Command Runner

The local command runner is shared by CLI-backed adapters.

Rules:

- It invokes commands without a shell.
- It passes the runtime directive as stdin or prompt input.
- It asks the provider to return the normalized `AgentResponse` JSON envelope.
- It builds a role-specific JSON Schema for the expected `AgentResponse`.
- It tells the provider to keep the JSON envelope mechanical and put long human-facing content in `data.<required_data_key>.markdown`.
- It redacts obvious secrets from captured process output before parsing.
- It fails closed with a schema-compatible blocked or failed response when output is unstructured.
- It does not use dangerous bypass flags.
- For read-only repo work, model-backed local command providers require an explicit provider-invocation approval before the first call.
- It runs edit-capable local agents in an isolated git worktree by default and captures the resulting patch as a `diff` artifact.
- It does not apply isolated patches itself; the runtime asks for approval and applies the patch deterministically during integration.
- It requires a clean target checkout before isolated edit execution so uncommitted user work is not silently excluded.
- It only runs edit-capable local agents in the target checkout when `THEHOOD_ALLOW_DIRECT_EDIT=1` is explicitly set.

## Stub Adapter

Purpose:

- Exercise the runtime loop without external model calls.
- Produce deterministic orchestrator, implementer, QA tester, critic, and verifier responses.
- Keep smoke tests stable while the real provider adapters are still being built.

Best roles:

- orchestrator
- implementer
- qa
- verifier
- critic

Rules:

- It must not edit files.
- It must use runtime evidence for verifier decisions.
- It exists for testing the orchestration contract, not for real work.

## ChatGPT Web Adapter

Purpose:

- Use the user's authenticated ChatGPT session for models only exposed in ChatGPT.
- Support ChatGPT Pro as an orchestrator or planner.

Current implementation:

- Provider id: `chatgpt-web`
- Default model: `chatgpt-pro`
- Requires `THEHOOD_CHATGPT_WEB_COMMAND`
- `thehood doctor` checks command executability, explicit model confirmation, Chrome DevTools reachability, and whether a ChatGPT tab is visible.
- Sends the runtime directive as stdin.
- Passes `--model <model>` and `--schema <schema-path>` to the bridge command.
- Expects stdout to contain the normalized `AgentResponse` JSON envelope.
- Directs ChatGPT to place plans and reports in the role payload's `markdown` string instead of deep nested JSON.
- Returns `blocked` when no bridge command is configured.

Included bridge:

- Binary: `thehood-chatgpt-web-bridge`
- Source: `src/bridges/chatgptWebBridge.ts`
- Uses Chrome DevTools Protocol against the TheHood-managed persistent browser profile by default.
- Requires explicit model confirmation through `THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED=1` or `--allow-unverified-model`.
- Creates a dedicated ChatGPT target by default, verifies that the composer is empty before sending the prompt, and closes the created target unless `THEHOOD_CHATGPT_WEB_KEEP_TARGET=1` is set.
- Requires ChatGPT responses to echo the current directive acknowledgement in the role payload, so schema-valid answers from stale browser/project context fail closed.
- Fails closed with a schema-compatible `blocked` or `failed` response when browser access, selectors, model confirmation, or response parsing fails.

Rules:

- Use the user's existing subscription and browser session.
- Do not bypass access controls.
- Do not extract cookies or tokens into logs.
- Do not rely on hidden chain-of-thought.
- Prefer structured visible outputs.
- Fail closed when the requested model cannot be confirmed.
- Fail closed when a fresh composer cannot be verified or when the response does not acknowledge the current directive.
- The bridge must not log cookies, local storage, tokens, or private browser profile data.

Best roles:

- orchestrator
- planner
- critic

Risk:

- Browser UI changes can break automation.
- Output extraction can be brittle.
- Terms and product behavior may change.

## ChatGPT MCP Connector Mode

Purpose:

- Let ChatGPT Pro inspect a local repo through TheHood without pre-sending a repo context pack.
- Use ChatGPT Developer Mode or Secure MCP Tunnel to connect ChatGPT to TheHood's MCP server.

Current implementation:

- Provider access mode: `mcp-connector`
- Transport target: `thehood mcp`
- Repo gateway tools:
  - `thehood_repo_tree`
  - `thehood_repo_search`
  - `thehood_repo_read_file`
  - `thehood_git_status`
  - `thehood_git_diff`
- Run gateway tools include existing status, artifact, approval, continue, and orchestration tools.

Rules:

- Treat ChatGPT as an MCP host, not as runtime authority.
- Expose read-only repo tools first.
- Keep edit and approval actions mediated by TheHood runtime gates.
- Do not expose `.git`, `.thehood`, dependency/build output, or secret-looking paths through repo gateway tools.
- Prefer Secure MCP Tunnel for private local repos so the MCP server does not need a public inbound endpoint.

## OpenAI API Adapter

Purpose:

- Use API-accessible GPT models for structured workers.

Best roles:

- implementer
- planner
- researcher
- verifier
- critic

Notes:

- Prefer structured output features when available.
- Keep raw provider responses out of public logs if they contain sensitive context.

## Anthropic API Adapter

Purpose:

- Use Claude models as guest agents or primary role owners.

Best roles:

- critic
- verifier
- architect/planner
- implementer when tool integration is available

Notes:

- Claude can be especially useful as an independent reviewer because it brings a different model family into the loop.
- It still must obey the same runtime permissions.

## Codex CLI Adapter

Purpose:

- Use Codex as an implementation or investigation worker.

Best roles:

- implementer
- researcher
- qa tester
- reviewer

Rules:

- Scope tasks tightly.
- Capture diffs and logs.
- Do not let Codex self-verify its own changes.
- QA tester output is advisory and cannot satisfy runtime validation proof.
- Run through `codex exec` with TheHood's role directive.
- Use `read-only` sandbox for non-editing roles.
- Require explicit provider-invocation approval before read-only repo calls.
- Pass the generated schema through `--output-schema`.
- Do not pass dangerous sandbox bypass flags.

## Claude Code Adapter

Purpose:

- Use Claude Code as a guest implementation or review worker.

Best roles:

- implementer
- critic
- verifier

Rules:

- Same separation rules as any other implementer.
- If Claude Code edits, another agent verifies.
- Run through `claude --print` with TheHood's role directive.
- Use plan/read tools for non-editing roles.
- Require explicit provider-invocation approval before read-only repo calls.
- Pass the generated schema through `--json-schema`.
- Do not pass permission bypass flags.

## Local Model Adapter

Purpose:

- Support private or cheap local workers.

Best roles:

- formatting
- simple refactors
- search summarization
- low-risk repetitive work

Rules:

- Keep tasks narrow.
- Do not use local model output as authoritative verification unless backed by deterministic logs.
