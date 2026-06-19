# Runtime Loop

TheHood runs a bounded agent loop. The loop is stateful, inspectable, and controlled by runtime rules rather than model habit.

## Loop Summary

```text
1. Receive user goal
2. Inspect repo and constraints
3. Ask orchestrator for plan
4. Request user approval when needed
5. Delegate scoped task to implementer
6. Capture diff and implementation notes
7. Run deterministic validation commands
8. Ask verifier for verdict using raw evidence
9. Ask critic when risk or ambiguity warrants it
10. Replan, revise, ask user, abort, or integrate
11. Produce final report with evidence
12. Reconcile planner state against implementation evidence when needed
```

Each provider call is preceded by a runtime-built directive artifact containing role instructions, prompt variables, tool permissions, and the expected output contract. The provider response must satisfy that contract before the runtime advances to the next state.

The runtime also records typed `handoffs` on the run record whenever work crosses a meaningful boundary between roles, an approval gate mediates the next transition, or a run completes. Display labels such as `Agent 1 / Orchestrator`, `Agent 2 / Implementer`, and `Agent 3 / Verifier` are derived from runtime roles and assignments. They are inspectable lane labels, not new permissions or authority.

Same-run summons are read-only sidecar calls attached to an existing run. A summon carries an explicit brief, kind such as `qa` or `critique`, optional one-call provider assignment, constraints, and artifact refs. The runtime records the handoff and provider artifacts, but the summoned agent does not advance the main state machine or gain edit authority. Model-backed summon providers still pass through provider-invocation approval; autopilot can auto-approve that bounded gate when policy allows it.

Review lanes are runtime-derived gate metadata, not separate schedulers. The runtime derives verifier, QA/validation, and critic lanes from existing canonical evidence such as verifier responses, validation command artifacts, tool events, and critic responses. Final reports and progress packets expose those lanes so CLI, MCP, TUI, and future app surfaces can display reviewer/tester/QA/critic state without owning orchestration logic. A summoned agent can add read-only evidence, but a summon does not satisfy or replace a required verifier or QA lane.

## State Machine

```text
created
  -> planning
  -> awaiting_approval
  -> delegating
  -> implementing
  -> verifying
  -> critiquing
  -> integrating
  -> completed

Any state
  -> failed
  -> aborted
```

## Iteration Inputs

Every iteration should include:

- current run state
- original user goal
- current plan
- previous findings
- current diff
- raw command logs
- verifier verdict
- critic verdict when present
- open questions
- remaining budget
- stop conditions

## Stop Conditions

The loop must stop when any of these are true:

- success criteria are satisfied
- max iterations reached
- token budget reached
- time budget reached
- command failure requires user action
- protected file change requires explicit approval
- model output fails schema validation repeatedly
- provider response status is `blocked` or `failed`
- user aborts the run

## Approval Gates

User approval is required before:

- editing files in a target repo unless the run mode already authorizes it
- modifying tests, fixtures, snapshots, or evaluation files
- installing dependencies
- running commands with external side effects
- using network access when the policy requires approval
- invoking model-backed providers such as `chatgpt-web`, `claude-code`, or `codex-cli` for read-only repo work
- sending runtime-captured repo context to browser or API model providers such as `chatgpt-web`, unless the user's external transfer policy auto-approves the manifest
- sending runtime-captured progress or memory packets to browser or API model providers, unless the user's external transfer policy auto-approves the manifest
- applying a worker patch to the main checkout
- continuing to verification after an applied worker patch changes protected test, fixture, snapshot, or eval paths
- switching orchestrator or verifier mid-run for an active task

When `approvalPolicy.mode` is `autopilot`, the user has pre-authorized the runtime to approve bounded low-risk gates without another prompt. Autopilot may approve provider invocation, implementation start, external transfers that pass transfer-manifest policy, and isolated patch application. It must still stop for secret-risk transfers, protected test/fixture/snapshot/eval changes, destructive or dependency/network commands that require explicit command approval, dirty-checkout integration blockers, max-iteration failures, and verifier revise/ask-user outcomes.

When an approval reason includes an exact phrase such as `Approval message must mention "apply isolated patch"`, the runtime enforces that phrase before recording an approving transition.

Before sending repo context or a progress packet to a browser or API provider, the runtime writes a `transfer_manifest` artifact. The approval gate points at that manifest so CLI, MCP, TUI, and future app surfaces can show the destination provider, purpose, source artifacts, byte counts, hashes, risk class, exact approval phrase, and bounded preview before anything leaves the machine. If the user configures `approvalPolicy.mode: auto_low_risk`, `approvalPolicy.mode: autopilot`, or `externalTransfers: auto_low_risk`, bounded transfers that do not have `secret_risk` can be auto-approved; the runtime still records the manifest, approval event, and `approval_auto_approved` event.

`maxIterations` is enforced from persisted provider responses. If the next transition would call another provider after the run has already recorded `maxIterations` agent responses, the runtime fails closed with reason `max_iterations`.

## Runtime-Owned Evidence

The runtime captures evidence directly:

- git status before and after
- diff before and after each worker
- command and args
- cwd
- exit code
- stdout
- stderr
- duration
- tool permission decision
- protected path classification
- final report artifacts for completed runs
- progress packet artifacts for later planner reconciliation
- derived review lane metadata for verifier, QA/validation, and critic evidence
- external transfer manifest artifacts before approved provider transfers
- typed handoff records for role delegation, approval mediation, and completion

Models may summarize evidence, but summaries are not authoritative.

## Memory

TheHood's memory is canonical runtime state, not provider session context. Exact artifacts, run records, command logs, diffs, approvals, verifier verdicts, and final reports are authoritative. Summaries, vector memories, graph memories, and model reflections are derived navigation layers.

Provider directives should assume that browser and API conversation context may be stale or empty. The runtime rehydrates providers from bounded packets that point back to exact artifacts.

## Final Reports

Completed read-only and verified implementation runs attach a `report` artifact with `kind: "final_report"`. The report includes the run goal, final state, stop reason, completing role, artifact refs, command metadata, and approval events. The runtime also stores a bounded progress packet artifact after completion so a later planner reconciliation step can ask for external-transfer approval using an exact artifact ref.

Provider status is also authoritative. A worker response with `blocked` pauses at an approval gate. A worker response with `failed` fails the run. The runtime must not advance blocked or failed implementation into verification.

## Planner Reconciliation

Planner reconciliation closes the loop after a plan has been implemented and verified. The runtime builds a progress packet from canonical artifacts, applies the user's external transfer approval policy, sends the packet to the selected planner or orchestrator after approval, validates the response, and stores the result as a reconciliation artifact.

Reconciliation should answer which plan items are complete, which criteria remain open, whether the implementation deviated from the plan, and what the next slice should be. It is advisory; runtime evidence and approval gates remain authoritative.

## Failure Classes

Verifier and runtime failures should be classified into stable categories:

- `test_failure`
- `lint_failure`
- `typecheck_failure`
- `build_failure`
- `schema_failure`
- `permission_denied`
- `approval_required`
- `provider_error`
- `ambiguous_goal`
- `unsafe_action`
- `budget_exhausted`
- `unknown_failure`

## Integration Rule

Only the runtime applies approved changes to the target checkout.

Implementers can produce patches. Local CLI implementers run in isolated git worktrees by default; TheHood captures their diff as a run artifact and stops before applying it. After explicit approval, deterministic runtime code applies the patch to the target checkout, captures a runtime-owned integration report artifact, and only then proceeds toward verification. If the integrated patch changes protected test, fixture, snapshot, or eval paths, the runtime stops for a separate approval before verification. Implementers do not get to self-merge.

## Current Loop

The current implementation can advance approved runs using the deterministic `stub` provider:

```text
delegating
  -> orchestrator response
  -> orchestrator response schema validation
  -> implementing
  -> implementer response
  -> implementer response schema validation
  -> awaiting_approval when an isolated patch artifact must be applied
  -> integrating
  -> awaiting_approval when integrated protected paths need separate approval
  -> verifying
  -> git evidence capture
  -> package validation command capture
  -> verifier response
  -> verifier response schema validation
  -> final report and progress packet artifacts
  -> completed or awaiting_approval
```

ChatGPT Web is wired through a user-configured bridge command. API model providers are not wired yet. Local Codex CLI and Claude Code adapters are available through the same directive and response-validation contract.

Read-only runs can also execute a mapped guest role directly:

- `plan` uses `planner` when assigned, otherwise `orchestrator`
- `research` uses `researcher` when assigned, otherwise `orchestrator`
- `review` uses `critic` when assigned, otherwise `orchestrator`

For read-only runs, model-backed providers such as `chatgpt-web`, `claude-code`, and `codex-cli` require an explicit provider-invocation approval before the first provider call. When a read-only orchestrator or planner returns `action: "delegate"` before repo context exists, the runtime captures a bounded `repo_context` artifact using deterministic filesystem reads. For browser or API model providers such as `chatgpt-web`, the runtime then writes a `transfer_manifest` artifact and stops at a second approval gate before sending that context back to the provider. If the role requests another delegation after a context pack exists, the runtime captures a follow-up context only when the structured decision names concrete repo paths that were not already captured or were previously captured only as truncated excerpts. Provider directives rehydrate repo context from all captured context artifacts, assembling continuation chunks into one ordered excerpt per path. Broad or fully duplicate repeated delegations still stop at an approval gate instead of looping indefinitely.
