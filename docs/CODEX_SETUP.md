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
- `THEHOOD_CHATGPT_WEB_KEEP_TARGET_ON_FAILURE=1`

Use `--cdp-url <url>` if Chrome is listening on a different DevTools endpoint.

Before starting the Codex app, check the local bridge readiness:

```bash
node dist/cli/main.js doctor --repo /path/to/repo --json
npm run smoke:codex-config -- --config ~/.codex/config.toml --repo /path/to/repo
```

For `chatgpt-web`, `doctor` verifies that the bridge command is configured and executable, the model confirmation guard is enabled, Chrome DevTools is reachable, a ChatGPT tab is visible, the page is authenticated, and the composer is ready. Common issues are `bridge_command_not_configured`, `model_not_confirmed`, `cdp_unreachable`, `chatgpt_tab_not_found`, `chatgpt_auth_required`, `chatgpt_composer_not_ready`, and `chatgpt_page_uninspectable`.

For `codex-cli`, `doctor` asks the installed Codex CLI for its current model catalog with `codex debug models`. TheHood keeps only sanitized model metadata, resolves friendly assignments such as `codex-cli:spark` against that live catalog, and reports `model_not_available:<model>` when a custom role assignment is not supported by the current CLI/account.

## Actual Codex App Verification

Add one generated TOML snippet to Codex's `config.toml`, then restart Codex so the MCP server list is rebuilt. A running Codex session should not be treated as proof because MCP servers are loaded at app or session startup.

After restart, the TheHood server should expose these tools:

- `thehood_doctor`
- `thehood_roles`
- `thehood_pro_access`
- `thehood_agent_board`
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

Use `thehood_doctor` as the in-chat stale-server check. Current builds report `runtime.capabilities`; if Codex does not show expected capabilities such as `structured_mcp_next_actions`, `approval_artifact_next_actions`, `protected_integrated_patch_gate`, `cli_artifact_reads`, `approval_phrase_enforcement`, `final_report_artifacts`, `mcp_final_report_next_action`, `canonical_memory_rehydration`, `provider_directive_ack`, `local_agent_execution_artifacts`, `max_iteration_enforcement`, `validation_command_capture`, `review_routing_policy`, `chatgpt_browser_manager`, `chatgpt_web_bridge_fail_fast`, `chatgpt_web_session_isolation`, `chatgpt_web_auth_readiness`, `branded_tui_shell`, `operator_next_actions`, `loop_responsibility_schedule`, `crew_lane_trail`, `revision_trail`, `runtime_loop_runner`, `autopilot_approval_policy`, `mcp_autopilot_continue_guidance`, `run_status_insights`, `same_run_agent_summons`, `bounded_same_run_fanout`, `runtime_team_presets`, `configurable_budget_envelopes`, `model_assisted_qa_tester`, `critic_trigger_artifacts`, `pro_access_preflight`, `codex_agent_board`, and `codex_agent_board_artifact`, the chat is still connected to an older MCP server process.

Codex can request renderable agent visibility by calling `thehood_agent_board` with `include_artifact: true`. The returned `artifact.manifest` and `artifact.snapshot` are dashboard payloads derived from runtime state and can be passed to an available Codex artifact renderer. Rendering remains a display layer: it does not schedule agents, approve gates, or grant tools.

Codex can inspect the Pro access path by calling `thehood_pro_access`. This is a local-only preflight: it does not call ChatGPT Pro and does not send repo context externally. Use it when a direct `chatgpt-web` consult is rejected by Codex host policy, when bridge readiness is unclear, or when the right answer is to switch to ChatGPT MCP connector mode instead of asking for the same approval again.

First verification sequence from a Codex chat:

1. Call `thehood_doctor` for the target repo and confirm active roles have no issues.
2. Call `thehood_roles` or `thehood_agent_board` and confirm the agent roster shows the intended orchestrator, implementer, QA, verifier, and critic owners.
3. Call `thehood_pro_access` before direct Pro consults from Codex. If Codex host policy blocks external disclosure, use the returned connector-mode handoff and do not repeat the same approval request.
4. Call `thehood_plan` for a harmless read-only goal.
5. Call `thehood_continue` with `approval: "none"` for that run. In manual mode, confirm it stops for explicit approval before invoking the configured read-only provider, which is Codex CLI by default. In autopilot mode, confirm provider invocation is auto-approved and recorded as `approval_auto_approved`.
6. Approve a provider invocation only when a manual approval gate is active and the user accepts calling the configured provider for the repo, then continue the run and confirm it returns schema-valid JSON.
7. If a ChatGPT Web or API provider is configured and delegates repo inspection, confirm the runtime creates a bounded `context` artifact. In manual mode it should stop for explicit approval before sending that context back to the provider; in autopilot or auto-low-risk transfer mode it may auto-approve a bounded non-secret manifest and record the transfer approval.
8. Approve the context transfer only when a manual transfer gate is active and the user accepts sending bounded repo evidence, then continue the run.
9. For implementation testing, call `thehood_orchestrate` in `implement` mode and confirm it stops for approval before edit-capable execution.

## Optional Codex Plugin

The repo includes an optional Codex plugin scaffold at `plugins/thehood-codex` and a repo-local marketplace at `.agents/plugins/marketplace.json`.

Install it only when you want Codex to load TheHood-specific workflow guidance and MCP wiring:

```bash
codex plugin marketplace add /path/to/the-hood
codex plugin add thehood-codex@thehood
```

Start a new Codex thread after installing or updating the plugin so Codex reloads plugin skills and MCP configuration.

The plugin's MCP server config runs `thehood mcp`, so the `thehood` binary must be available on `PATH`. For local development, either link/install the package after `npm run build` or keep using the explicit local snippet from:

```bash
node dist/cli/main.js mcp config
```

## Native Codex Subagents

Codex's native Subagents panel is owned by Codex subagent workflows, not by MCP tool output. TheHood cannot directly register an arbitrary running provider call into that panel through `thehood_agent_board` or another MCP tool.

This repository does not include repo-root `.codex/agents/` custom agents by default because those agents make Codex show a native Subagents surface even when the user did not ask for it.

If a future TheHood plugin version offers opt-in custom agents, use them only when the user explicitly wants Codex-native subagent threads. For example:

```text
Use TheHood native subagents for this review. Spawn thehood-qa and thehood-critic in parallel, wait for both, and summarize their findings with file references.
```

Those spawned Codex agents should appear in the native Codex Subagents panel. They inherit the parent session's model, MCP servers, sandbox, and approvals unless Codex is told otherwise. Any custom agents are presentation and delegation helpers for Codex-native workflows; TheHood runtime state, artifacts, approvals, and verifier separation remain authoritative.

Use `thehood_agent_board` with `include_artifact: true` when you want TheHood runtime-owned role visibility rendered as an in-chat dashboard instead of native Codex subagent threads.

## Recommended First Codex Chat

After Codex can see TheHood tools:

1. Ask Codex to call `thehood_doctor` for the repo.
2. Ask Codex to call `thehood_agent_board` and inspect the visible agent cards before changing any role owner.
3. Ask Codex to call `thehood_pro_access` before Pro consults. If Codex host policy rejects direct external disclosure to ChatGPT Web, use the connector-mode handoff instead of repeating the rejected request.
4. Ask Codex to call `thehood_consult` or `thehood_fanout` with read-only guest roles. When no manual gate is active, Codex should continue with `approval: "none"` and let TheHood autopilot auto-approve bounded provider gates when policy allows.
5. Use `thehood_orchestrate` for implementation work.
6. Use `thehood_continue` with explicit approval only for active manual approval gates.

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
export THEHOOD_CHATGPT_WEB_RUN_SCOPED_TARGETS=1
# export THEHOOD_CHATGPT_WEB_REUSE_CHAT=1
# export THEHOOD_CHATGPT_WEB_KEEP_TARGET=1
# export THEHOOD_CHATGPT_WEB_KEEP_TARGET_ON_FAILURE=0
```

By default, TheHood runtime calls use one ChatGPT target per run. The first bridge call creates and verifies a fresh composer, then later ChatGPT Web calls in the same run reuse that target instead of opening a new chat after every Pro answer. The bridge still requires the visible response to echo the current `directiveAck` inside the role payload, so stale project or conversation context fails closed. Calls without a run id keep the older one-target-per-call lifecycle: close after a successfully parsed response, keep the target open when browser access, parsing, acknowledgement, or timeout handling fails. Set `THEHOOD_CHATGPT_WEB_REUSE_CHAT=1` only when intentionally debugging against the current conversation, set `THEHOOD_CHATGPT_WEB_RUN_SCOPED_TARGETS=0` to disable run-scoped target reuse, and set `THEHOOD_CHATGPT_WEB_KEEP_TARGET_ON_FAILURE=0` only when you want failed bridge calls to clean up their temporary tabs.

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
