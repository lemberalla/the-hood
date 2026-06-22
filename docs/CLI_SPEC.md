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
thehood agent-board
thehood agent-board --artifact --json
thehood teams
thehood teams apply pro-orchestrator
thehood teams apply claude-second-judge
thehood teams apply spark-plus-sonnet
thehood teams apply claude-builder
thehood teams apply pro-claude-high-assurance
thehood roles
thehood roles set orchestrator codex-cli:default
thehood roles set orchestrator chatgpt-web:chatgpt-pro
thehood roles set implementer claude-code:sonnet
thehood roles set verifier claude-code:sonnet
thehood roles set critic claude-code:fable
thehood recommend-loop "Fix flaky checkout tests" --repo . --max-iterations 5
thehood recommend-loop "Prepare public release" --repo . --acceptance "README claims match implemented behavior" --validation "npm run smoke:mcp" --allowed-path README.md --forbidden-change "Do not publish private run logs"
thehood goal "Prepare release metadata" --repo . --max-iterations 5
thehood run "Implement the requested change" --repo .
thehood run "Implement the requested change" --repo . --loop
thehood plan "Design the feature" --repo .
thehood plan "Design the feature" --repo . --loop
thehood status
thehood status <run-id>
thehood agent-board <run-id>
thehood agent-board <run-id> --artifact --json
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

## Goal Surface

`thehood goal "<goal>" --repo . --max-iterations 5` creates a normal bounded implementation run and immediately drives the existing headless loop. It is a product-facing alias over `run` plus `loop`, not a scheduler.

`--max-iterations` applies only to the created run. It does not change repo config defaults and does not create timer loops, background daemons, cloud queues, or new approval behavior.

## Loop Recommendation

`thehood recommend-loop "<goal>" --repo . --max-iterations 5` is a read-only loop router. It recommends one public loop recipe, returns a recommended stack, drafts a completion contract, shows alternatives, and returns the MCP/Codex `runAction` shape for the existing runtime path.

Recommendation does not start a run, call model providers, edit files, create schedules, approve gates, or send context externally. It is meant to answer "which loop shape fits this outcome?" before `thehood goal` or `thehood_orchestrate` starts the governed runtime loop.

The draft contract can be edited before a run starts with repeatable `--acceptance`, `--validation`, `--allowed-path`, and `--forbidden-change` flags. These options update only the recommendation output and returned runtime constraints; they do not grant permissions or bypass runtime approvals.

## Role Selection

Role mapping can be set globally, per repo, or per run.

`thehood roster --repo .` prints the full agent roster: display lane labels such as `Agent 1 / Orchestrator` and `Agent 2 / Implementer`, provider:model owner, whether the assignment is the product default or repo config, readiness issues from `doctor`, role purpose, and read/edit/shell/network authority. `--json` returns the same roster as structured data so Codex, MCP clients, and future app surfaces can render the same source of truth.

`thehood agent-board [run-id] --repo .` prints a runtime-derived agent board for Codex card-style visibility. Without a run id, the board is a repo-scope view over the configured roster and health. With a run id, each card can include the current crew/review/responsibility lane, blocking state, sidecar status, and bounded artifact/event/handoff refs for that run. Add `--artifact --json` to return `{ "board": ..., "artifact": ... }`, where `artifact` is a bounded dashboard manifest and snapshot suitable for Codex app artifact rendering. The board and dashboard payload are display guidance only: they do not grant tools, schedule agents, satisfy gates, or approve work.

`thehood teams --repo .` lists runtime-owned role presets. `thehood teams apply codex-default|pro-orchestrator|claude-critic|claude-second-judge|spark-plus-sonnet|claude-builder|pro-claude-high-assurance --repo .` writes that preset into repo config through the same role invariants as manual role assignment. Presets are convenience maps, not new authority: provider readiness, invocation approvals, transfer gates, and verifier separation still apply.

Codex is the product default:

```bash
thehood roles set orchestrator codex-cli:default --repo .
thehood roles set implementer codex-cli:default --repo .
thehood roles set qa codex-cli:spark --repo .
thehood roles set verifier codex-cli:spark --repo .
thehood roles set critic codex-cli:spark --repo .
```

Users can tune every role, including orchestrator. The Codex CLI adapter discovers the current catalog with `codex debug models`; for example, `codex-cli:gpt-5.5` can be used when that slug is available in the user's Codex CLI. Claude Code and ChatGPT Web support configured/custom model passthrough, so users can choose aliases such as `claude-code:sonnet`, `claude-code:fable`, `claude-code:mythos`, or `chatgpt-web:configured` when those models are available through the user's local provider setup.

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

TheHood may also create `.thehood/runs` and `.thehood/artifacts` when a plan, run, orchestration, validation, or provider call records evidence. In git checkouts, TheHood automatically adds `.thehood/` and `.thehood-browser.json` to `.git/info/exclude` before writing repo-local runtime state. This keeps local evidence out of normal `git status` without mutating the repo's committed `.gitignore`. Users can delete `.thehood/` to clear local run history.

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
      "models": ["chatgpt-pro", "configured"],
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
      "models": ["configured", "claude-opus", "claude-sonnet", "claude-haiku", "opus", "sonnet", "haiku", "mythos", "fable"],
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
      "models": ["default", "configured", "sonnet", "opus", "haiku", "mythos", "fable"],
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

`thehood status <run-id>` includes runtime-owned status plus insights from attached artifacts: the latest schema-valid agent response, its primary output such as `decision`, a bounded preview of any provider `markdown` payload, the final report artifact when present, latest progress packet, reconciliation, repo context, remote repo context, local provider execution, review routing, critic trigger, revision packet, fan-out, and transfer manifest refs when present, derived revision trails, derived crew lanes, derived review ownership lanes, bounded loop responsibility schedules, bounded operator next actions, a bounded handoff timeline, and a structured `agentBoard` snapshot for Codex app/card rendering. JSON output preserves the existing run fields, including the full `handoffs` array, and adds an `insights` object with `revisionTrail`, `crewLanes`, `reviewLanes`, `loopResponsibilities`, `operatorNextActions`, `latestHandoff`, `handoffTimeline`, `latestRemoteRepoContext`, `latestProviderExecution`, `recentProviderExecutions`, `latestReviewRouting`, `latestCriticTrigger`, `latestRevisionPacket`, `latestFanout`, and bounded refs-only `canonicalMemory`. Provider execution insights include only role, provider/model, command, args, workspace mode, sandbox or permission mode, exit code, timeout state, parse status, duration, and artifact ref. Review routing includes the latest risk tier, selected next action, required lanes, compact signals, reasons, and artifact ref only. Revision trails link each revision packet to delegation, repair response, post-repair validation, review responses, and completion refs when present. Crew lanes include role/runtime owner, authority, required/advisory state, whether the lane satisfies required gates, compact summaries, and artifact/event/handoff refs only. Review lanes include owner assignment, required/optional state, whether the lane satisfies required gates, compact summaries, and artifact/event refs only. Loop responsibilities include planner/orchestrator, implementer, verifier, runtime QA/validation, model-assisted QA tester, critic, reconciliation, integration, operator approval, and completion ownership as runtime-derived refs-only display guidance. Operator next actions include the suggested action, owner, blocking/required state, compact reason, optional CLI/MCP hints, and artifact/event refs only; they are display guidance, not enforcement. Full provider markdown remains in the response artifact and should be read with `thehood artifact` when needed.

`thehood logs <run-id>` prints stored runtime events and a bounded `handoffs` section. Handoff labels such as `Agent 1 / Orchestrator` and `Agent 2 / Implementer` are derived from runtime roles and provider assignments; they are display lanes, not policy grants.

`thehood diff <run-id>` reads the latest attached `diff` artifact for a run. This is mainly useful for reviewing isolated worker patches before approval.

`thehood exec <run-id> -- <command> [args...]` runs a deterministic command without a shell and stores stdout/stderr as artifacts. Risky commands such as destructive git operations, dependency installs, and network commands require `--allow-risky`.

`thehood plan ... --loop` and `thehood run ... --loop` create the run and immediately pass it to the same headless loop runner. The default without `--loop` remains create-only, so callers can still inspect or approve the starting boundary before provider invocation.

`thehood continue <run-id>` advances the runtime loop until it reaches a terminal state, a gate, or its internal step cap. When no manual approval gate is active, continuing is the normal autopilot-aware path: runtime policy may auto-approve bounded provider invocation and non-secret transfer-manifest gates and records those decisions as `approval_auto_approved` events. With `stub` roles, an approved implement run advances through orchestrator, implementer, git evidence capture, QA, optional critic, revision packet repair when needed, and verifier phases without external model calls.

`thehood loop <run-id> --repo .` is the headless autopilot runner. It repeatedly calls the runtime advance path until the run reaches `completed`, `failed`, or `aborted`, stops for a manual approval gate, makes no progress, or reaches the caller's cycle cap. It accepts `--max-cycles <n>` and `--max-steps <n>`; defaults are 8 cycles and 10 advance steps per cycle. It does not approve manual gates itself. In `autopilot` policy mode, the runtime may still auto-approve bounded gates and records those decisions as normal approval evidence.

`thehood reconcile <run-id>` reconciles a completed run by sending its latest `progress` artifact to the configured `planner`, or to the `orchestrator` when no planner is assigned. Browser and API providers such as `chatgpt-web`, `openai-api`, and `anthropic-api` first write a `transfer_manifest` artifact and pause at an approval gate before the progress packet is sent. After approval, the provider response is stored as a `reconciliation` artifact.

`thehood summon <run-id> --role <role> --brief <text>` attaches a read-only same-run agent call to an existing run. Summon roles are `orchestrator`, `planner`, `researcher`, `qa`, `verifier`, and `critic`; use `--kind qa|review|critique|research|plan` to label the handoff. `--agent provider:model` overrides the role assignment for that one call without changing the run's role mapping. The runtime records an `agent_summoned` event, a typed handoff, directive and response artifacts when the provider runs, redacted local-provider stdout/stderr log refs when a local command provider is used, and the usual approval gate when a model-backed provider invocation needs approval. Summon responses may appear as sidecar review ownership evidence, but they cannot satisfy required verifier or runtime QA/validation lanes.

`thehood fanout <run-id> --items-json <json-array>` runs a bounded group of same-run summons on an existing run. Each item includes `role`, `brief`, and optional `agent`, `kind`, `persona`, `constraints`, and `evidenceRefs`. The runtime hard cap is 8 items, and repo config `defaults.fanoutMaxItems` can lower the per-project policy cap. Execution is currently sequential so approval gates remain simple and auditable. If a fan-out item opens an approval gate, later items wait until that gate is handled. If a read-only advisory item returns malformed output or another contained provider failure without opening a gate, the runtime records that item as blocked or failed and continues to the remaining items. Fan-out writes a compact `fanout` artifact with item statuses, artifact refs, bounds, and a safety note that the evidence is advisory only. Fan-out responses may populate QA tester or critic sidecar lanes, but they do not satisfy required verifier, runtime QA, approval, or completion gates.

`thehood transfer preview <run-id>` reads the latest `transfer_manifest` artifact for a run without sending anything externally. The preview includes destination provider, purpose, source artifacts, byte counts, hashes, risk class, approval phrase, and a bounded content preview.

`thehood approvals policy show` prints the configured approval policy. `thehood approvals policy set mode manual|auto-low-risk|autopilot` controls the global approval posture. `manual` stops at approval gates, `auto-low-risk` allows bounded non-secret external transfers, and `autopilot` lets the runtime auto-approve bounded gates such as provider invocation, implementation start, external transfers, isolated patch application, and runtime-owned revision packet repair while still stopping for protected test changes, secret-risk transfers, destructive commands, dependency installs, dirty-checkout integration blockers, verifier `ask_user` or `abort`, unsafe critic feedback, and max-iteration failures.

`thehood approvals policy set external-transfers manual|auto-low-risk` remains available for transfer-specific policy tuning. It controls whether repo context and progress packet transfers always stop for manual approval or can be auto-approved when the manifest is bounded and does not have `secret_risk`.

For read-only `plan`, `research`, and `review` runs, direct `chatgpt-web` role calls and same-run summons can attach refs-only `remote_context` before the provider call when local git reports a clean GitHub checkout whose `HEAD` matches the tracked upstream ref and the active ChatGPT Web bridge GitHub connector surface is confirmed. An orchestrator or planner can also request `action: "delegate"` before enough repo evidence exists; the runtime applies that same confirmed GitHub connector route before falling back to local context capture. The `remote_context` artifact directs ChatGPT Web to use its GitHub connector at the exact commit. Otherwise, the runtime captures a bounded `context` artifact with deterministic filesystem reads. Browser and API providers first write a `transfer_manifest` artifact before local repo context bodies are sent back to the provider. Manual policy pauses at an approval gate; `auto-low-risk` and `autopilot` may auto-approve bounded non-secret manifests and record the approval event before sending. If the provider later delegates concrete repo paths that were not in previous context packs, the runtime captures a targeted follow-up context and applies the same transfer review policy before sending it.

When `codex-cli` or `claude-code` is selected, TheHood invokes the local CLI in non-interactive mode with a runtime-built directive and requires a normalized JSON `AgentResponse` before advancing. The JSON envelope carries mechanical fields, while plans, reports, reviews, and rationale should be returned as markdown in the role payload's `markdown` field. For read-only repo work, model-backed provider invocation pauses at an approval gate before the first provider call. After the command exits, TheHood writes redacted stdout/stderr `log` artifacts and a bounded `provider_invocation` artifact so status can show which local role command actually ran and where to inspect its output. `codex-cli` models are discovered from `codex debug models`; friendly names such as `spark` resolve against that live catalog, and `doctor` reports `model_not_available:<model>` when a custom assignment is not supported by the current CLI/account. `claude-code` model names such as `sonnet`, `fable`, and `mythos` are passthrough aliases; TheHood records them and passes explicit non-default names to the user's local Claude CLI. `configured` uses the local CLI default for Codex and Claude and is not sent as a literal model name.

OpenAI and Anthropic API provider configs include `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` env names for future API adapters. Those providers are disabled and not implemented until their adapters are wired; use Codex CLI, ChatGPT Web, Claude Code, or `stub` for current runs.

## Doctor Command

`thehood doctor --repo .` reports provider and role readiness without invoking model calls.

It checks:

- runtime name, package version, and capability flags for stale-process detection
- whether providers are configured and enabled
- whether the provider adapter is implemented
- provider access modes such as `agent-bridge`, `api-agent`, and `mcp-connector`
- whether local CLI commands such as `codex` and `claude` are available on `PATH`
- whether the ChatGPT Web bridge command, model confirmation guard, Chrome DevTools endpoint, ChatGPT tab, authenticated page, and composer are ready when `chatgpt-web` is configured
- whether configured role models are listed for their providers and, for `codex-cli`, whether the live `codex debug models` catalog can resolve them
- provider model policy: `listed`, `discovered`, or `passthrough`

## Browser Manager Commands

`thehood browser start` launches a persistent isolated Chrome profile for ChatGPT Web at the default CDP endpoint `http://127.0.0.1:9222`. Runtime bridge calls reuse one ChatGPT target per run by default, so follow-up context and planning calls stay in the same Pro conversation unless `THEHOOD_CHATGPT_WEB_RUN_SCOPED_TARGETS=0` is set.

`thehood browser status` reports CDP reachability, profile path, ChatGPT tab presence, authenticated page readiness, composer readiness, and whether the bridge is ready.

`thehood browser stop` stops the Chrome process only when it can verify that the recorded process belongs to the TheHood-managed profile.

## TUI Command

`thehood --repo .` prints the branded terminal dashboard shell by default. `thehood ui --repo .` is the explicit equivalent. The dashboard reads runtime health, role mapping, browser readiness, approval inbox, and a derived run monitor from existing runtime APIs; it does not own orchestration logic. The run monitor shows active provider waits, approval gates, transfer gates, completed runs, crew lane trails, revision trails when present, and reviewer/tester/QA/critic ownership lanes from runtime evidence.

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
thehood teams apply codex-default|pro-orchestrator|claude-critic|claude-second-judge|spark-plus-sonnet|claude-builder|pro-claude-high-assurance --repo .
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
- a connector validation path using `thehood_doctor` and read-only repo gateway tools

The tunnel helper is for MCP connector mode, where ChatGPT is the MCP host. It is separate from `thehood mcp config --chatgpt-web`, which configures the `chatgpt-web` browser bridge for TheHood-initiated agent-bridge calls.

Use the local-build command while developing this checkout so ChatGPT sees the current `dist` output. Use the installed-package command after publishing or installing TheHood.
