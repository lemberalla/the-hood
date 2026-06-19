# CLI Spec

The CLI is TheHood's first control surface. It should be complete enough to run headless without Codex or the macOS menubar app.

The working command name is `thehood`.

## Commands

```bash
thehood init
thehood setup
thehood config show
thehood config set max-iterations 8
thehood config set fanout-max-items 4
thehood models
thehood providers
thehood doctor
thehood roster
thehood teams
thehood teams apply pro-orchestrator
thehood roles
thehood roles set orchestrator codex-cli:default
thehood roles set orchestrator chatgpt-web:chatgpt-pro
thehood run "Implement the requested change" --repo .
thehood run "Implement the requested change" --repo . --loop
thehood plan "Design the feature" --repo .
thehood plan "Design the feature" --repo . --loop
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
thehood approvals policy show
thehood approvals policy set mode autopilot
thehood approvals policy set external-transfers auto-low-risk
thehood continue <run-id>
thehood loop <run-id>
thehood reconcile <run-id>
thehood summon <run-id> --role qa --agent codex-cli:spark --brief "Look for missed cases"
thehood fanout <run-id> --items-json '[{"role":"qa","agent":"stub:qa","brief":"Look for missed cases"}]'
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
thehood ui settings
thehood ui settings crew
thehood ui settings commands
thehood approvals policy set mode autopilot
thehood approvals policy set external-transfers auto-low-risk
thehood config set max-iterations 8
thehood config set fanout-max-items 4
thehood teams apply codex-default
thehood roles set qa codex-cli:spark
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

`thehood roster --repo .` prints the full agent roster: display lane labels such as `Agent 1 / Orchestrator` and `Agent 2 / Implementer`, provider:model owner, whether the assignment is the product default or repo config, readiness issues from `doctor`, role purpose, and read/edit/shell/network authority. `--json` returns the same roster as structured data so Codex, MCP clients, and future app surfaces can render the same source of truth.

`thehood teams --repo .` lists runtime-owned role presets. `thehood teams apply codex-default|pro-orchestrator|claude-critic --repo .` writes that preset into repo config through the same role invariants as manual role assignment. Presets are convenience maps, not new authority: provider readiness, invocation approvals, transfer gates, and verifier separation still apply.

Codex is the product default:

```bash
thehood roles set orchestrator codex-cli:default --repo .
thehood roles set implementer codex-cli:default --repo .
thehood roles set qa codex-cli:spark --repo .
thehood roles set verifier codex-cli:spark --repo .
thehood roles set critic codex-cli:spark --repo .
```

Users can tune every role, including orchestrator. Provider model strings are passed to CLI-backed adapters; for example, `codex-cli:fable` can be used if that alias is available in the user's Codex CLI.

```bash
thehood run "Add export flow" \
  --repo . \
  --orchestrator chatgpt-web:chatgpt-pro \
  --planner codex-cli:default \
  --researcher codex-cli:default \
  --implementer codex-cli:default \
  --qa codex-cli:spark \
  --verifier codex-cli:spark \
  --critic claude-code:sonnet
```

Deterministic local loop smoke:

```bash
thehood run "Exercise the loop" \
  --repo . \
  --orchestrator stub:orchestrator \
  --implementer stub:implementer \
  --qa stub:qa \
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
    "maxIterations": 8,
    "fanoutMaxItems": 8,
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
      "models": ["default", "spark", "configured"],
      "accessModes": ["agent-bridge"],
      "defaultAccessMode": "agent-bridge"
    },
    "claude-code": {
      "enabled": true,
      "models": ["default", "configured"],
      "accessModes": ["agent-bridge"],
      "defaultAccessMode": "agent-bridge"
    },
    "stub": {
      "enabled": true,
      "models": ["orchestrator", "planner", "researcher", "implementer", "qa", "verifier", "critic"],
      "accessModes": ["agent-bridge"],
      "defaultAccessMode": "agent-bridge"
    }
  },
  "roles": {
    "orchestrator": {
      "provider": "codex-cli",
      "model": "default"
    },
    "implementer": {
      "provider": "codex-cli",
      "model": "default"
    },
    "qa": {
      "provider": "codex-cli",
      "model": "spark"
    },
    "verifier": {
      "provider": "codex-cli",
      "model": "spark"
    },
    "critic": {
      "provider": "codex-cli",
      "model": "spark"
    }
  }
}
```

`thehood config set max-iterations <n>` updates the provider-call budget used when new runs are created. `thehood config set fanout-max-items <n>` updates the repo-local fan-out policy cap. The runtime hard cap for fan-out remains 8 items; users can lower the repo cap for cost or latency control.

## Setup Helper

`thehood setup --repo .` is a read-only launcher report. It prints the correct local-build command, a temporary shell alias, optional `npm link` and future package install commands, MCP config commands, and local/installed TUI launch commands. It does not install, link, mutate shell profiles, or change runtime config.

Use it when a local checkout works through `node dist/cli/main.js ...` but `thehood` is not on the shell `PATH` yet.

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

`thehood status <run-id>` includes runtime-owned status plus insights from attached artifacts: the latest schema-valid agent response, its primary output such as `decision`, a bounded preview of any provider `markdown` payload, the final report artifact when present, latest progress packet, reconciliation, repo context, remote repo context, local provider execution, review routing, critic trigger, revision packet, fan-out, and transfer manifest refs when present, derived review ownership lanes, bounded loop responsibility schedules, bounded operator next actions, and a bounded handoff timeline. JSON output preserves the existing run fields, including the full `handoffs` array, and adds an `insights` object with `reviewLanes`, `loopResponsibilities`, `operatorNextActions`, `latestHandoff`, `handoffTimeline`, `latestRemoteRepoContext`, `latestProviderExecution`, `recentProviderExecutions`, `latestReviewRouting`, `latestCriticTrigger`, `latestRevisionPacket`, `latestFanout`, and bounded refs-only `canonicalMemory`. Provider execution insights include only role, provider/model, command, args, workspace mode, sandbox or permission mode, exit code, timeout state, parse status, duration, and artifact ref. Review routing includes the latest risk tier, selected next action, required lanes, compact signals, reasons, and artifact ref only. Review lanes include owner assignment, required/optional state, whether the lane satisfies required gates, compact summaries, and artifact/event refs only. Loop responsibilities include planner/orchestrator, implementer, verifier, runtime QA/validation, model-assisted QA tester, critic, reconciliation, integration, operator approval, and completion ownership as runtime-derived refs-only display guidance. Operator next actions include the suggested action, owner, blocking/required state, compact reason, optional CLI/MCP hints, and artifact/event refs only; they are display guidance, not enforcement. Full provider markdown remains in the response artifact and should be read with `thehood artifact` when needed.

`thehood logs <run-id>` prints stored runtime events and a bounded `handoffs` section. Handoff labels such as `Agent 1 / Orchestrator` and `Agent 2 / Implementer` are derived from runtime roles and provider assignments; they are display lanes, not policy grants.

`thehood diff <run-id>` reads the latest attached `diff` artifact for a run. This is mainly useful for reviewing isolated worker patches before approval.

`thehood exec <run-id> -- <command> [args...]` runs a deterministic command without a shell and stores stdout/stderr as artifacts. Risky commands such as destructive git operations, dependency installs, and network commands require `--allow-risky`.

`thehood plan ... --loop` and `thehood run ... --loop` create the run and immediately pass it to the same headless loop runner. The default without `--loop` remains create-only, so callers can still inspect or approve the starting boundary before provider invocation.

`thehood continue <run-id>` advances the runtime loop until it reaches a terminal state, a gate, or its internal step cap. When no manual approval gate is active, continuing is the normal autopilot-aware path: runtime policy may auto-approve bounded provider invocation and non-secret transfer-manifest gates and records those decisions as `approval_auto_approved` events. With `stub` roles, an approved implement run advances through orchestrator, implementer, git evidence capture, QA, optional critic, revision packet repair when needed, and verifier phases without external model calls.

`thehood loop <run-id> --repo .` is the headless autopilot runner. It repeatedly calls the runtime advance path until the run reaches `completed`, `failed`, or `aborted`, stops for a manual approval gate, makes no progress, or reaches the caller's cycle cap. It accepts `--max-cycles <n>` and `--max-steps <n>`; defaults are 8 cycles and 10 advance steps per cycle. It does not approve manual gates itself. In `autopilot` policy mode, the runtime may still auto-approve bounded gates and records those decisions as normal approval evidence.

`thehood reconcile <run-id>` reconciles a completed run by sending its latest `progress` artifact to the configured `planner`, or to the `orchestrator` when no planner is assigned. Browser and API providers such as `chatgpt-web`, `openai-api`, and `anthropic-api` first write a `transfer_manifest` artifact and pause at an approval gate before the progress packet is sent. After approval, the provider response is stored as a `reconciliation` artifact.

`thehood summon <run-id> --role <role> --brief <text>` attaches a read-only same-run agent call to an existing run. Summon roles are `orchestrator`, `planner`, `researcher`, `qa`, `verifier`, and `critic`; use `--kind qa|review|critique|research|plan` to label the handoff. `--agent provider:model` overrides the role assignment for that one call without changing the run's role mapping. The runtime records an `agent_summoned` event, a typed handoff, directive and response artifacts when the provider runs, and the usual approval gate when a model-backed provider invocation needs approval. Summon responses may appear as sidecar review ownership evidence, but they cannot satisfy required verifier or runtime QA/validation lanes.

`thehood fanout <run-id> --items-json <json-array>` runs a bounded group of same-run summons on an existing run. Each item includes `role`, `brief`, and optional `agent`, `kind`, `persona`, `constraints`, and `evidenceRefs`. The runtime hard cap is 8 items, and repo config `defaults.fanoutMaxItems` can lower the per-project policy cap. Execution is currently sequential so approval gates remain simple and auditable. Fan-out writes a compact `fanout` artifact with item statuses, artifact refs, bounds, and a safety note that the evidence is advisory only. Fan-out responses may populate QA tester or critic sidecar lanes, but they do not satisfy required verifier, runtime QA, approval, or completion gates.

`thehood transfer preview <run-id>` reads the latest `transfer_manifest` artifact for a run without sending anything externally. The preview includes destination provider, purpose, source artifacts, byte counts, hashes, risk class, approval phrase, and a bounded content preview.

`thehood approvals policy show` prints the configured approval policy. `thehood approvals policy set mode manual|auto-low-risk|autopilot` controls the global approval posture. `manual` stops at approval gates, `auto-low-risk` allows bounded non-secret external transfers, and `autopilot` lets the runtime auto-approve bounded gates such as provider invocation, implementation start, external transfers, isolated patch application, and runtime-owned revision packet repair while still stopping for protected test changes, secret-risk transfers, destructive commands, dependency installs, dirty-checkout integration blockers, verifier `ask_user` or `abort`, unsafe critic feedback, and max-iteration failures.

`thehood approvals policy set external-transfers manual|auto-low-risk` remains available for transfer-specific policy tuning. It controls whether repo context and progress packet transfers always stop for manual approval or can be auto-approved when the manifest is bounded and does not have `secret_risk`.

For read-only `plan`, `research`, and `review` runs, an orchestrator or planner can request `action: "delegate"` before enough repo evidence exists. When `chatgpt-web` is the provider and local git reports a clean GitHub checkout whose `HEAD` matches the tracked upstream ref, the runtime can attach a refs-only `remote_context` artifact and direct ChatGPT Web to use its GitHub connector at that exact commit. Otherwise, the runtime captures a bounded `context` artifact with deterministic filesystem reads. Browser and API providers first write a `transfer_manifest` artifact before local repo context bodies are sent back to the provider. Manual policy pauses at an approval gate; `auto-low-risk` and `autopilot` may auto-approve bounded non-secret manifests and record the approval event before sending. If the provider later delegates concrete repo paths that were not in previous context packs, the runtime captures a targeted follow-up context and applies the same transfer review policy before sending it.

When `codex-cli` or `claude-code` is selected, TheHood invokes the local CLI in non-interactive mode with a runtime-built directive and requires a normalized JSON `AgentResponse` before advancing. The JSON envelope carries mechanical fields, while plans, reports, reviews, and rationale should be returned as markdown in the role payload's `markdown` field. For read-only repo work, model-backed provider invocation pauses at an approval gate before the first provider call. After the command exits, TheHood writes a bounded `provider_invocation` artifact so status can show which local role command actually ran. CLI-backed providers list `configured` as a model wildcard, so `thehood doctor` accepts custom model aliases and the provider CLI remains responsible for rejecting unavailable models at execution time.

OpenAI and Anthropic API provider configs include `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` env names for future API adapters. Those providers are disabled and not implemented until their adapters are wired; use Codex CLI, ChatGPT Web, Claude Code, or `stub` for current runs.

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

`thehood ui --repo .` prints the branded terminal dashboard shell. It reads runtime health, role mapping, browser readiness, approval inbox, and a derived run monitor from existing runtime APIs; it does not own orchestration logic. The run monitor shows active provider waits, approval gates, transfer gates, completed runs, and reviewer/tester/QA/critic ownership lanes from runtime evidence.

The dashboard also includes an approval inbox. `thehood ui approvals --repo .` prints pending manual approval gates with the runtime reason, suggested approval message, related artifacts, and button-style approve/reject/revise/resume commands. It also shows recent autopilot approvals separately so operators can see what was auto-approved, why it qualified, and which artifact or transfer manifest was involved. The same inbox includes recent agent handoffs so operators can see which runtime lane handed work to the next lane or to an approval gate.

Approval actions can be triggered without retyping the required approval phrase:

```bash
thehood ui approvals --repo . --approve <run-id>
thehood ui approvals --repo . --reject <run-id>
thehood ui approvals --repo . --revise <run-id>
```

The TUI only calls existing runtime approval transitions; it does not decide whether an approval is safe.

`thehood ui settings --repo .` opens the compact settings cockpit. Focused pages live under the same settings surface: `thehood ui settings crew|providers|budgets|safety|browser|commands|all --repo .`.

The settings command deck prints the existing runtime-owned commands for common edits:

```bash
thehood approvals policy set mode manual|auto-low-risk|autopilot --repo .
thehood approvals policy set external-transfers manual|auto-low-risk --repo .
thehood config set max-iterations 8 --repo .
thehood config set fanout-max-items 4 --repo .
thehood teams apply codex-default|pro-orchestrator|claude-critic --repo .
thehood roles set verifier codex-cli:spark --repo .
thehood browser status
thehood browser start
thehood browser stop
```

The settings UI displays and routes these controls. It does not create a new orchestration path, bypass role invariants, or weaken approval gates.

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
