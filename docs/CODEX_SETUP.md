# Codex Setup

TheHood is exposed to Codex through its MCP server.

## Build

```bash
npm install
npm run build
node dist/cli/main.js setup --repo .
```

`setup` is read-only. It prints the local-build command, a temporary shell alias, optional `npm link` guidance, MCP config commands, and TUI launch commands for the current checkout.

## Get MCP Config

For an installed package:

```bash
thehood mcp config
```

For this local checkout:

```bash
node dist/cli/main.js mcp config
```

The command prints two TOML snippets:

- installed package: `command = "thehood"`
- local build: `command = "node"` with the absolute path to `dist/cli/main.js`

Use one snippet in Codex's MCP server configuration.

For ChatGPT Pro through the included browser bridge, start the TheHood-managed browser profile and select the intended model:

```bash
node dist/cli/main.js browser start
node dist/cli/main.js browser status
```

The browser manager uses a persistent isolated Chrome profile under `~/Library/Application Support/TheHood/ChromeProfiles/chatgpt-web` on macOS. The user signs into ChatGPT in that profile once; TheHood does not copy cookies, local storage, or tokens.

Then use the opt-in config generator:

```bash
node dist/cli/main.js mcp config --chatgpt-web
```

This adds:

- `THEHOOD_CHATGPT_WEB_COMMAND`
- `THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED=1`
- `THEHOOD_CHATGPT_WEB_CDP_URL=http://127.0.0.1:9222`
- `THEHOOD_CHATGPT_WEB_TIMEOUT_MS=300000`

Use `--cdp-url <url>` if Chrome is listening on a different DevTools endpoint.

Before starting the Codex app, check the local bridge readiness:

```bash
node dist/cli/main.js doctor --repo /path/to/repo --json
npm run smoke:codex-config -- --config ~/.codex/config.toml --repo /path/to/repo
```

For `chatgpt-web`, `doctor` verifies that the bridge command is configured and executable, the model confirmation guard is enabled, Chrome DevTools is reachable, and a ChatGPT tab is visible. Common issues are `bridge_command_not_configured`, `model_not_confirmed`, `cdp_unreachable`, and `chatgpt_tab_not_found`.

## Actual Codex App Verification

Add one generated TOML snippet to Codex's `config.toml`, then restart Codex so the MCP server list is rebuilt. A running Codex session should not be treated as proof because MCP servers are loaded at app or session startup.

After restart, the TheHood server should expose these tools:

- `thehood_doctor`
- `thehood_roles`
- `thehood_assign_roles`
- `thehood_plan`
- `thehood_orchestrate`
- `thehood_consult`
- `thehood_summon`
- `thehood_fanout`
- `thehood_continue`
- `thehood_loop`
- `thehood_reconcile`
- `thehood_status`
- `thehood_runs`
- `thehood_read_artifact`
- `thehood_capture_evidence`
- `thehood_abort`

When developing TheHood itself, rebuild and restart the Codex app or MCP session before validating newly changed tool output. Existing Codex chats can keep an already-started MCP server process alive, so code changes may pass `smoke:codex-config` while the current chat still shows the previous tool behavior.

Use `thehood_doctor` as the in-chat stale-server check. Current builds report `runtime.capabilities`; if Codex does not show expected capabilities such as `structured_mcp_next_actions`, `approval_artifact_next_actions`, `protected_integrated_patch_gate`, `cli_artifact_reads`, `approval_phrase_enforcement`, `final_report_artifacts`, `mcp_final_report_next_action`, `canonical_memory_rehydration`, `provider_directive_ack`, `local_agent_execution_artifacts`, `max_iteration_enforcement`, `validation_command_capture`, `review_routing_policy`, `chatgpt_browser_manager`, `chatgpt_web_bridge_fail_fast`, `chatgpt_web_session_isolation`, `branded_tui_shell`, `operator_next_actions`, `loop_responsibility_schedule`, `runtime_loop_runner`, `autopilot_approval_policy`, `mcp_autopilot_continue_guidance`, `run_status_insights`, `same_run_agent_summons`, `bounded_same_run_fanout`, `runtime_team_presets`, `configurable_budget_envelopes`, `model_assisted_qa_tester`, and `critic_trigger_artifacts`, the chat is still connected to an older MCP server process.

First verification sequence from a Codex chat:

1. Call `thehood_doctor` for the target repo and confirm active roles have no issues.
2. Call `thehood_roles` or `thehood roster --repo .` and confirm the agent roster shows the intended orchestrator, implementer, QA, verifier, and critic owners.
3. Call `thehood_plan` for a harmless read-only goal.
4. Call `thehood_continue` with `approval: "none"` for that run. In manual mode, confirm it stops for explicit approval before invoking the configured read-only provider, which is Codex CLI by default. In autopilot mode, confirm provider invocation is auto-approved and recorded as `approval_auto_approved`.
5. Approve a provider invocation only when a manual approval gate is active and the user accepts calling the configured provider for the repo, then continue the run and confirm it returns schema-valid JSON.
6. If a ChatGPT Web or API provider is configured and delegates repo inspection, confirm the runtime creates a bounded `context` artifact. In manual mode it should stop for explicit approval before sending that context back to the provider; in autopilot or auto-low-risk transfer mode it may auto-approve a bounded non-secret manifest and record the transfer approval.
7. Approve the context transfer only when a manual transfer gate is active and the user accepts sending bounded repo evidence, then continue the run.
8. For implementation testing, call `thehood_orchestrate` in `implement` mode and confirm it stops for approval before edit-capable execution.

## Recommended First Codex Chat

After Codex can see TheHood tools:

1. Ask Codex to call `thehood_doctor` for the repo.
2. Ask Codex to call `thehood_roles` and inspect the roster before changing any role owner.
3. Ask Codex to call `thehood_consult` or `thehood_fanout` with read-only guest roles. When no manual gate is active, Codex should continue with `approval: "none"` and let TheHood autopilot auto-approve bounded provider gates when policy allows.
4. Use `thehood_orchestrate` for implementation work.
5. Use `thehood_continue` with explicit approval only for active manual approval gates.

Example guest critic:

```json
{
  "goal": "Critique this implementation plan before code changes.",
  "repo_path": "/path/to/repo",
  "role": "critic",
  "agent": "codex-cli:spark"
}
```

Example QA tester:

```json
{
  "goal": "Review the current evidence and suggest missing validation commands.",
  "repo_path": "/path/to/repo",
  "role": "qa",
  "agent": "codex-cli:spark"
}
```

Example ChatGPT Pro orchestrator consult:

```json
{
  "goal": "Plan the safest implementation path before workers start.",
  "repo_path": "/path/to/repo",
  "role": "orchestrator",
  "agent": "chatgpt-web:chatgpt-pro"
}
```

`chatgpt-web` requires a local bridge executable:

```bash
export THEHOOD_CHATGPT_WEB_COMMAND=/path/to/chatgpt-web-bridge
```

The bridge receives the TheHood prompt on stdin, gets `--model <model>` and `--schema <schema-path>` arguments, uses the user's authenticated ChatGPT session, and prints the normalized `AgentResponse` JSON envelope to stdout. The JSON envelope is for mechanical fields; long plans, reports, and rationale should be returned as markdown in the role payload's `markdown` string. TheHood intentionally does not read ChatGPT cookies, browser local storage, or tokens.

This package includes an experimental Chrome DevTools bridge:

```bash
npm run build
export THEHOOD_CHATGPT_WEB_COMMAND=/path/to/thehood/dist/bridges/chatgptWebBridge.js
```

Start the TheHood-managed browser profile, open ChatGPT, sign in if needed, and select the model you want the bridge to use:

```bash
node dist/cli/main.js browser start
```

After you have visibly selected the intended model in ChatGPT, enable the model confirmation guard:

```bash
export THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED=1
```

Optional bridge settings:

```bash
export THEHOOD_CHATGPT_WEB_CDP_URL=http://127.0.0.1:9222
export THEHOOD_CHATGPT_WEB_FRESH_URL=https://chatgpt.com/
export THEHOOD_CHATGPT_WEB_TIMEOUT_MS=300000
export THEHOOD_CHATGPT_WEB_PROMPT_SELECTOR="#prompt-textarea,[contenteditable='true'],textarea"
export THEHOOD_CHATGPT_WEB_SEND_SELECTOR="button[data-testid='send-button'],button[aria-label*='Send'],button[aria-label*='send']"
export THEHOOD_CHATGPT_WEB_RESPONSE_SELECTOR="[data-message-author-role='assistant']"
export THEHOOD_CHATGPT_WEB_NEW_CHAT_SELECTOR="a[href='/'],button[aria-label*='New chat']"
# export THEHOOD_CHATGPT_WEB_REUSE_CHAT=1
# export THEHOOD_CHATGPT_WEB_KEEP_TARGET=1
```

By default, the bridge creates a dedicated ChatGPT target for each request, verifies that the composer has no prior assistant messages, and closes that target after the response. It also requires the visible response to echo the current `directiveAck` inside the role payload. If ChatGPT restores an old conversation, or if the model returns schema-valid JSON from stale project context, the bridge fails closed instead of handing that answer to the runtime. Set `THEHOOD_CHATGPT_WEB_REUSE_CHAT=1` only when intentionally debugging against the current conversation.

Example persistent role assignment:

```json
{
  "repo_path": "/path/to/repo",
  "role_mapping": {
    "orchestrator": "codex-cli:default",
    "qa": "codex-cli:spark",
    "critic": "codex-cli:spark",
    "verifier": "codex-cli:spark"
  }
}
```

The implementer and verifier must still be separate assignments.
