# Codex Setup

TheHood is exposed to Codex through its MCP server.

## Build

```bash
npm install
npm run build
```

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

For ChatGPT Pro through the included browser bridge, use the opt-in config generator after launching the debug Chrome profile and selecting the intended model:

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
- `thehood_continue`
- `thehood_status`
- `thehood_runs`
- `thehood_read_artifact`
- `thehood_capture_evidence`
- `thehood_abort`

When developing TheHood itself, rebuild and restart the Codex app or MCP session before validating newly changed tool output. Existing Codex chats can keep an already-started MCP server process alive, so code changes may pass `smoke:codex-config` while the current chat still shows the previous tool behavior.

Use `thehood_doctor` as the in-chat stale-server check. Current builds report `runtime.capabilities`; if Codex does not show expected capabilities such as `structured_mcp_next_actions`, `approval_artifact_next_actions`, `protected_integrated_patch_gate`, `cli_artifact_reads`, `approval_phrase_enforcement`, and `final_report_artifacts`, the chat is still connected to an older MCP server process.

First verification sequence from a Codex chat:

1. Call `thehood_doctor` for the target repo and confirm active roles have no issues.
2. Call `thehood_plan` for a harmless read-only goal.
3. Call `thehood_continue` for that run and confirm it stops for explicit approval before invoking ChatGPT Pro.
4. Approve the provider invocation only when the user accepts calling ChatGPT Web for the repo, then continue the run and confirm ChatGPT Pro returns schema-valid JSON.
5. If Pro delegates repo inspection, confirm the runtime creates a bounded `context` artifact and then stops for explicit approval before sending that context back to ChatGPT Web.
6. Approve the context transfer only when the user accepts sending bounded repo evidence to ChatGPT Web, then continue the run.
7. For implementation testing, call `thehood_orchestrate` in `implement` mode and confirm it stops for approval before edit-capable execution.

## Recommended First Codex Chat

After Codex can see TheHood tools:

1. Ask Codex to call `thehood_doctor` for the repo.
2. Ask Codex to call `thehood_consult` with a read-only guest role and approve the provider-invocation gate before Claude, Codex, or Pro is called.
3. Use `thehood_orchestrate` for implementation work.
4. Use `thehood_continue` only after approving the run boundary.

Example guest critic:

```json
{
  "goal": "Critique this implementation plan before code changes.",
  "repo_path": "/path/to/repo",
  "role": "critic",
  "agent": "claude-code:opus"
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

The bridge receives the TheHood prompt on stdin, gets `--model <model>` and `--schema <schema-path>` arguments, uses the user's authenticated ChatGPT session, and prints the normalized `AgentResponse` JSON envelope to stdout. TheHood intentionally does not read ChatGPT cookies, browser local storage, or tokens.

This package includes an experimental Chrome DevTools bridge:

```bash
npm run build
export THEHOOD_CHATGPT_WEB_COMMAND=/path/to/thehood/dist/bridges/chatgptWebBridge.js
```

Launch a separate browser profile with remote debugging enabled, open ChatGPT, sign in, and select the model you want the bridge to use:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/thehood-chatgpt-profile
```

After you have visibly selected the intended model in ChatGPT, enable the model confirmation guard:

```bash
export THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED=1
```

Optional bridge settings:

```bash
export THEHOOD_CHATGPT_WEB_CDP_URL=http://127.0.0.1:9222
export THEHOOD_CHATGPT_WEB_TIMEOUT_MS=300000
export THEHOOD_CHATGPT_WEB_PROMPT_SELECTOR="#prompt-textarea,[contenteditable='true'],textarea"
export THEHOOD_CHATGPT_WEB_SEND_SELECTOR="button[data-testid='send-button'],button[aria-label*='Send'],button[aria-label*='send']"
export THEHOOD_CHATGPT_WEB_RESPONSE_SELECTOR="[data-message-author-role='assistant']"
# export THEHOOD_CHATGPT_WEB_REUSE_CHAT=1
```

By default, the bridge opens a fresh ChatGPT composer for each request so prior conversation state or delivery errors do not affect the run. Set `THEHOOD_CHATGPT_WEB_REUSE_CHAT=1` only when intentionally debugging against the current conversation.

Example persistent role assignment:

```json
{
  "repo_path": "/path/to/repo",
  "role_mapping": {
    "orchestrator": "codex-cli:default",
    "critic": "claude-code:opus",
    "verifier": "claude-code:sonnet"
  }
}
```

The implementer and verifier must still be separate assignments.
