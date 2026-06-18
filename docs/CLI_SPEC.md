# CLI Spec

The CLI is TheHood's first control surface. It should be complete enough to run headless without Codex or the macOS menubar app.

The working command name is `thehood`.

## Commands

```bash
thehood init
thehood config show
thehood config edit
thehood models
thehood providers
thehood doctor
thehood roles
thehood roles set orchestrator chatgpt-web:chatgpt-pro
thehood run "Implement the requested change" --repo .
thehood plan "Design the feature" --repo .
thehood status
thehood status <run-id>
thehood logs <run-id>
thehood artifact <run-id> <artifact-ref>
thehood evidence <run-id>
thehood exec <run-id> -- npm run build
thehood diff <run-id>
thehood approve <run-id>
thehood reject <run-id>
thehood revise <run-id>
thehood continue <run-id>
thehood abort <run-id>
thehood mcp
thehood mcp config
thehood mcp config --chatgpt-web
thehood mcp tunnel --tunnel-id <tunnel-id>
thehood browser start
thehood browser status
thehood browser stop
thehood ui
thehood ui approvals
```

## Run Modes

| Mode | Behavior |
| --- | --- |
| `plan` | Read-only planning and decomposition |
| `research` | Read-only exploration and findings |
| `implement` | Scoped edits after approval policy allows them |
| `review` | Independent diff or repo review |

## Role Selection

Role mapping can be set globally, per repo, or per run.

```bash
thehood run "Add export flow" \
  --repo . \
  --orchestrator chatgpt-web:chatgpt-pro \
  --planner claude-code:opus \
  --researcher claude-code:sonnet \
  --implementer codex-cli:gpt-5.5-low \
  --verifier anthropic-api:claude-opus \
  --critic anthropic-api:claude-sonnet
```

Deterministic local loop smoke:

```bash
thehood run "Exercise the loop" \
  --repo . \
  --orchestrator stub:orchestrator \
  --implementer stub:implementer \
  --verifier stub:verifier \
  --critic stub:critic

thehood approve <run-id>
thehood continue <run-id>
```

## Config File

The current implementation uses `.thehood/config.json` to avoid adding a YAML parser before the runtime is stable.

Initial config shape:

```json
{
  "version": 1,
  "defaults": {
    "maxIterations": 5,
    "editRequiresApproval": true,
    "dependencyInstallRequiresApproval": true,
    "networkRequiresApproval": true,
    "protectedTestPaths": [
      "**/test/**",
      "**/tests/**",
      "**/*.spec.*",
      "**/*.test.*",
      "**/__snapshots__/**",
      "**/fixtures/**",
      "**/evals/**"
    ]
  },
  "providers": {
    "chatgpt-web": {
      "enabled": true,
      "models": ["chatgpt-pro"],
      "accessModes": ["agent-bridge", "mcp-connector"],
      "defaultAccessMode": "agent-bridge",
      "browserProfile": "default"
    },
    "openai-api": {
      "enabled": false,
      "models": ["configured"],
      "accessModes": ["api-agent"],
      "defaultAccessMode": "api-agent",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    "anthropic-api": {
      "enabled": false,
      "models": ["claude-opus", "claude-sonnet"],
      "accessModes": ["api-agent"],
      "defaultAccessMode": "api-agent",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    },
    "codex-cli": {
      "enabled": true,
      "models": ["default"],
      "accessModes": ["agent-bridge"],
      "defaultAccessMode": "agent-bridge"
    },
    "claude-code": {
      "enabled": true,
      "models": ["default"],
      "accessModes": ["agent-bridge"],
      "defaultAccessMode": "agent-bridge"
    },
    "stub": {
      "enabled": true,
      "models": ["orchestrator", "planner", "researcher", "implementer", "verifier", "critic"],
      "accessModes": ["agent-bridge"],
      "defaultAccessMode": "agent-bridge"
    }
  },
  "roles": {
    "orchestrator": {
      "provider": "chatgpt-web",
      "model": "chatgpt-pro"
    },
    "implementer": {
      "provider": "codex-cli",
      "model": "default"
    },
    "verifier": {
      "provider": "claude-code",
      "model": "default"
    },
    "critic": {
      "provider": "claude-code",
      "model": "default"
    }
  }
}
```

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | General failure |
| `2` | Invalid user input |
| `3` | Approval required |
| `4` | Provider unavailable |
| `5` | Verification failed |
| `6` | Permission denied |
| `7` | Schema validation failed |

## Output Modes

The CLI should support:

- human-readable output by default
- `--json` for automation
- `--quiet` for scripts
- `--verbose` for debugging

## Runtime Evidence Commands

`thehood evidence <run-id>` captures runtime-owned evidence:

- `git status --short --untracked-files=all`
- `git diff --no-ext-diff`
- protected path matches from configured test, fixture, snapshot, and eval patterns

TheHood excludes its own `.thehood` runtime directory from this evidence.

`thehood artifact <run-id> <artifact-ref>` reads a bounded artifact that is already attached to the run. It uses the same safety boundary as `thehood_read_artifact`: refs must stay inside that run's artifact directory and must already be recorded on the run.

`thehood diff <run-id>` reads the latest attached `diff` artifact for a run. This is mainly useful for reviewing isolated worker patches before approval.

`thehood exec <run-id> -- <command> [args...]` runs a deterministic command without a shell and stores stdout/stderr as artifacts. Risky commands such as destructive git operations, dependency installs, and network commands require `--allow-risky`.

`thehood continue <run-id>` advances the runtime loop until it reaches a terminal state or a gate. With `stub` roles, an approved implement run advances through orchestrator, implementer, git evidence capture, and verifier phases without external model calls.

For read-only `plan`, `research`, and `review` runs, an orchestrator or planner can request `action: "delegate"` before enough repo evidence exists. The runtime responds by capturing a bounded `context` artifact with deterministic filesystem reads, then calls the same role again with that context attached.

When `codex-cli` or `claude-code` is selected, TheHood invokes the local CLI in non-interactive mode with a runtime-built directive and requires a normalized JSON `AgentResponse` before advancing. For read-only repo work, model-backed provider invocation pauses at an approval gate before the first provider call.

## Doctor Command

`thehood doctor --repo .` reports provider and role readiness without invoking model calls.

It checks:

- runtime name, package version, and capability flags for stale-process detection
- whether providers are configured and enabled
- whether the provider adapter is implemented
- provider access modes such as `agent-bridge`, `api-agent`, and `mcp-connector`
- whether local CLI commands such as `codex` and `claude` are available on `PATH`
- whether the ChatGPT Web bridge command, model confirmation guard, Chrome DevTools endpoint, and ChatGPT tab are ready when `chatgpt-web` is configured
- whether configured role models are listed for their providers

## Browser Manager Commands

`thehood browser start` launches a persistent isolated Chrome profile for ChatGPT Web at the default CDP endpoint `http://127.0.0.1:9222`.

`thehood browser status` reports CDP reachability, profile path, ChatGPT tab presence, and whether the bridge is ready.

`thehood browser stop` stops the Chrome process only when it can verify that the recorded process belongs to the TheHood-managed profile.

## TUI Command

`thehood ui --repo .` prints the first branded terminal dashboard shell. It reads runtime health, role mapping, and browser readiness from existing runtime APIs; it does not own orchestration logic.

The dashboard also includes an approval inbox. `thehood ui approvals --repo .` prints only pending approval gates with the runtime reason, suggested approval message, related artifacts, and button-style approve/reject/revise/resume commands.

Approval actions can be triggered without retyping the required approval phrase:

```bash
thehood ui approvals --repo . --approve <run-id>
thehood ui approvals --repo . --reject <run-id>
thehood ui approvals --repo . --revise <run-id>
```

The TUI only calls existing runtime approval transitions; it does not decide whether an approval is safe.

## ChatGPT MCP Tunnel Helper

`thehood mcp tunnel` prints Secure MCP Tunnel setup commands for both installed-package and local-build use.

```bash
thehood mcp tunnel --tunnel-id tunnel_0123456789abcdef --profile thehood-local
node dist/cli/main.js mcp tunnel --tunnel-id tunnel_0123456789abcdef --profile thehood-local
```

The helper does not start the tunnel or contact OpenAI. It prints:

- `tunnel-client init` with `sample_mcp_stdio_local`
- `tunnel-client doctor`
- `tunnel-client run`
- ChatGPT Developer Mode connector setup notes

Use the local-build command while developing this checkout so ChatGPT sees the current `dist` output. Use the installed-package command after publishing or installing TheHood.
