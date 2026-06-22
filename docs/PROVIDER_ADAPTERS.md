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

`chatgpt-atlas` is an experimental `agent-bridge` provider for a local Computer Use transport. The adapter invokes the packaged `thehood-chatgpt-atlas-bridge` command by default and passes the runtime directive through stdin. The bridge owns the Atlas request protocol, fail-closed parsing, directive acknowledgement checks, and deterministic fake transport. For real desktop use, the bridge delegates UI control to a trusted local Computer Use controller command that operates the user-selected ChatGPT Atlas window, verifies the requested model, and returns a verified controller result envelope containing the normalized `AgentResponse`.

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

When the runtime supplies `context.criticTrigger` to a critic, the provider should treat it as the reason for an advisory review only. The adapter must not turn critic output into validation success, verifier approval, or edit authority.

The product default is Codex-first: `codex-cli:default` for orchestration and implementation, and `codex-cli:spark` for QA, verification, and critique. Users can replace any role assignment, including orchestrator, with ChatGPT Web, Claude Code, API providers once implemented, or future CLI model aliases.

Provider model policy is visible in `doctor` and `models` output:

| Policy | Meaning |
| --- | --- |
| `listed` | The provider accepts only configured model names. |
| `discovered` | The provider exposes a live model catalog and the runtime can mark unavailable aliases. |
| `passthrough` | The provider accepts custom model names because the user's local CLI, bridge, connector, or API account owns model availability. |

The `configured` model means "use the provider's configured or default selection" for local CLI providers. Explicit non-default names such as `sonnet`, `fable`, `mythos`, or a live Codex model slug remain role assignments and are passed to the provider when supported.

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
- Model policy: `passthrough`
- Requires `THEHOOD_CHATGPT_WEB_COMMAND`
- `thehood doctor` checks command executability, explicit model confirmation, Chrome DevTools reachability, whether a ChatGPT tab is visible, and whether the page is authenticated with a ready composer.
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
- Treats ChatGPT Web GitHub connector access as unconfirmed unless `THEHOOD_CHATGPT_WEB_GITHUB_CONNECTOR_CONFIRMED=1` is set after verifying the active bridge session can use that connector.
- Fails fast with a blocked response when the visible ChatGPT page requires login.
- Creates a dedicated ChatGPT target for the first bridge call in a TheHood run, stores that target by run id, and reuses it for later ChatGPT Web calls in the same run so context follow-ups do not spawn new chats after every Pro answer.
- Verifies a fresh composer before the first prompt in a run-scoped target and keeps directive acknowledgement checks on every response so reused run tabs do not accept stale provider-session output.
- For bridge calls without a run id, closes the created target after a successfully parsed response and keeps the target open on failed or timed-out ingestion so the visible answer can be inspected or recovered.
- Set `THEHOOD_CHATGPT_WEB_KEEP_TARGET=1` or pass `--keep-target` to keep all created targets, including successful responses.
- Set `THEHOOD_CHATGPT_WEB_RUN_SCOPED_TARGETS=0` or pass `--no-run-scoped-target` to restore one-target-per-call behavior.
- Set `THEHOOD_CHATGPT_WEB_KEEP_TARGET_ON_FAILURE=0` or pass `--close-target-on-failure` to restore cleanup after failed ingestion.
- Requires ChatGPT responses to echo the current directive acknowledgement in the role payload, so schema-valid answers from stale browser/project context fail closed.
- Fails closed with a schema-compatible `blocked` or `failed` response when browser access, selectors, model confirmation, or response parsing fails.
- Launches configured `.js`, `.mjs`, and `.cjs` bridge commands through the current Node executable, and resolves the installed `thehood-chatgpt-web-bridge` alias to the bundled bridge path, so MCP hosts do not depend on `env node` or PATH for the bridge script itself.

Rules:

- Use the user's existing subscription and browser session.
- Do not bypass access controls.
- Do not extract cookies or tokens into logs.
- Do not rely on hidden chain-of-thought.
- Prefer structured visible outputs.
- Fail closed when the requested model cannot be confirmed.
- Fail closed when the authenticated ChatGPT page or composer cannot be verified.
- Fail closed when a fresh composer cannot be verified or when the response does not acknowledge the current directive.
- The bridge must not log cookies, local storage, tokens, or private browser profile data.
- When the directive includes `context.remoteRepoContext`, use ChatGPT Web's GitHub connector for the named owner, repo, branch, and commit instead of asking TheHood to send local file excerpts. The runtime only selects this route after connector access has been confirmed for the active bridge path. If the connector cannot access the repo or commit, ask TheHood for bounded local repo context.

Best roles:

- orchestrator
- planner
- critic

Risk:

- Browser UI changes can break automation.
- Output extraction can be brittle.
- Terms and product behavior may change.

## ChatGPT Atlas Computer Use Adapter

Purpose:

- Let a user route planning or research work to a visible ChatGPT Atlas session when no Codex-native Atlas plugin is available.
- Keep Atlas behind the same TheHood provider gates, artifacts, provider waits, and response contract as other browser-backed providers.

Current implementation:

- Provider id: `chatgpt-atlas`
- Default models: `chatgpt-pro` or `configured`
- Model policy: `passthrough`
- Enabled by default and setup-gated in built-in config.
- Uses `thehood-chatgpt-atlas-bridge` by default; `THEHOOD_CHATGPT_ATLAS_COMMAND` remains an override for custom bridge builds.
- Real Computer Use transport requires `THEHOOD_CHATGPT_ATLAS_TARGET_CONFIRMED=1` after the user selects and confirms the intended Atlas window.
- Real Computer Use transport uses the packaged `thehood-chatgpt-atlas-controller` in generated MCP config; `THEHOOD_CHATGPT_ATLAS_COMPUTER_USE_COMMAND` remains an override for custom controllers.
- Fake transport for deterministic smoke tests uses `THEHOOD_CHATGPT_ATLAS_TRANSPORT=fake` plus `THEHOOD_CHATGPT_ATLAS_FAKE_RESPONSE` or `THEHOOD_CHATGPT_ATLAS_FAKE_RESPONSE_FILE`.
- Sends the runtime directive as stdin.
- Passes `--model <model>`, `--schema <schema-path>`, `--target "ChatGPT Atlas"`, and `--transport computer-use` to the bridge command.
- Includes `modelSelection` in the bridge request. For `chatgpt-pro`, the controller must verify or select an acceptable Pro label before posting the prompt.
- Launches configured `.js`, `.mjs`, and `.cjs` bridge commands through the current Node executable so Computer Use bridge scripts do not rely on shebang resolution inside MCP host environments.
- Expects stdout to contain a `thehood_chatgpt_atlas_computer_use_result` envelope with `model`, `modelVerified`, optional `observedModel`, and the normalized `AgentResponse` in `response`.
- Returns `blocked` when the provider is disabled, the target window is not confirmed, or no Computer Use controller is configured.
- Returns `blocked` when a real Computer Use controller returns a raw `AgentResponse` without model verification.
- Rejects schema-valid but stale provider output when the response does not echo the current directive acknowledgement.

Computer Use controller protocol:

- Command: `THEHOOD_CHATGPT_ATLAS_COMPUTER_USE_COMMAND`
- Packaged command: `thehood-chatgpt-atlas-controller`
- Args: `--target <target> --model <model> --schema <schema-path> --timeout-ms <n>`
- Stdin: JSON object with `kind: "thehood_chatgpt_atlas_computer_use_request"`, `target`, `model`, `modelSelection`, `transport`, `timeoutMs`, `requiredDataKey`, `prompt`, and `directiveAck`.
- Stdout: a JSON object with `kind: "thehood_chatgpt_atlas_computer_use_result"`, `schemaVersion: 1`, `model`, `modelVerified`, optional `observedModel`, and `response`.
- The controller must operate only the selected Atlas window and must fail closed if the target changes, the requested model cannot be selected or verified, the composer is not ready, ChatGPT is still generating, or the response cannot be extracted safely.

Rules:

- Use a visible, user-selected ChatGPT Atlas window.
- Treat Computer Use as a transport, not as runtime authority.
- Do not bypass access controls, subscriptions, provider UI warnings, or the user's confirmation boundaries.
- Do not upload files, navigate to unrelated external sites, save browser credentials, alter account settings, or transmit sensitive data unless the user explicitly approves that concrete action.
- Keep provider invocation, repo-context transfer, progress-packet transfer, and response validation owned by TheHood runtime.
- Fail closed when the bridge command cannot confirm the active Atlas target, cannot verify the requested model before posting, cannot post the directive, cannot see a complete answer, or cannot return the current directive acknowledgement.

Best roles:

- planner
- researcher
- orchestrator for narrow advisory loops

Risk:

- Atlas UI and model selector behavior may change.
- Computer Use can click/type in a real local app, so risky UI actions require action-time user confirmation.
- The bridge command must not log cookies, local storage, browser profile data, or private account state.

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

- Current implementation status: provider config exists, but the adapter is not wired yet.
- Model policy: `passthrough`, but unavailable until the adapter is implemented and enabled.
- Default API key env name: `OPENAI_API_KEY`.
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

- Current implementation status: provider config exists, but the adapter is not wired yet.
- Model policy: `passthrough`, but unavailable until the adapter is implemented and enabled.
- Default API key env name: `ANTHROPIC_API_KEY`.
- Claude can be especially useful as an independent reviewer because it brings a different model family into the loop.
- It still must obey the same runtime permissions.

## Codex CLI Adapter

Purpose:

- Use Codex as the default orchestrator, implementation, QA, verification, critique, or investigation worker.

Best roles:

- orchestrator
- implementer
- researcher
- qa tester
- verifier
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
- Write redacted stdout/stderr `log` artifacts and a bounded `provider_invocation` artifact after the local command exits so status can show the role, provider/model, command args, workspace mode, sandbox, exit code, timeout state, output refs, parse status, and isolated patch ref when present.
- Do not pass dangerous sandbox bypass flags.
- Built-in friendly assignments are `default`, `spark`, and `configured`, but the active Codex model catalog comes from `codex debug models`. The runtime stores only a sanitized catalog with model slugs, display names, visibility, and reasoning/speed metadata. Friendly assignments such as `spark` resolve against the live catalog before TheHood passes `--model` to Codex CLI; unsupported custom strings are reported by `doctor` before a run.
- Model policy: `discovered`. `configured` uses the local Codex CLI default and is not passed as a literal model name.

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
- Model policy: `passthrough`.
- Built-in models are `default`, `configured`, `sonnet`, `opus`, `haiku`, `mythos`, and `fable`. `configured` uses the local Claude CLI default and is not passed as a literal model name. Explicit aliases such as `sonnet`, `fable`, or `mythos` are passed through to the user's local Claude CLI.

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
