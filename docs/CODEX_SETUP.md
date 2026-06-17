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

## Recommended First Codex Chat

After Codex can see TheHood tools:

1. Ask Codex to call `thehood_doctor` for the repo.
2. Ask Codex to call `thehood_consult` with a read-only guest role.
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
export THEHOOD_CHATGPT_WEB_TIMEOUT_MS=120000
export THEHOOD_CHATGPT_WEB_PROMPT_SELECTOR="#prompt-textarea,[contenteditable='true'],textarea"
export THEHOOD_CHATGPT_WEB_SEND_SELECTOR="button[data-testid='send-button'],button[aria-label*='Send'],button[aria-label*='send']"
export THEHOOD_CHATGPT_WEB_RESPONSE_SELECTOR="[data-message-author-role='assistant']"
```

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
