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
8. Ask the mapped read-only QA tester for missed cases and validation suggestions
9. Ask verifier for verdict using raw evidence
10. Ask critic when risk or ambiguity warrants it
11. Write a revision packet and delegate repair when findings are fixable
12. Ask user, abort, or integrate when runtime policy requires it
13. Produce final report with evidence
14. Reconcile planner state against implementation evidence when needed
```

Each provider call is preceded by a runtime-built directive artifact containing role instructions, prompt variables, tool permissions, and the expected output contract. The provider response must satisfy that contract before the runtime advances to the next state.

Provider directives include a `directiveAck` marker. Browser-backed adapters must require the current marker in the provider response before accepting schema-valid JSON, which prevents stale ChatGPT Web project or conversation context from being mistaken for the current run.

The `AgentResponse` JSON envelope is deliberately mechanical. It carries status, a short summary, required role-control fields such as `action`, `status`, or `verdict`, refs, and the directive acknowledgement. Human-facing plans, reports, reviews, critique, rationale, acceptance criteria, and long next-step writeups should live in `data.<required_data_key>.markdown` as GitHub-flavored Markdown. Status surfaces expose only a bounded markdown preview plus the response artifact ref; the full response artifact remains the source of truth.

The runtime also records typed `handoffs` on the run record whenever work crosses a meaningful boundary between roles, an approval gate mediates the next transition, or a run completes. Display labels such as `Agent 1 / Orchestrator`, `Agent 2 / Implementer`, and `Agent 3 / Verifier` are derived from runtime roles and assignments. They are inspectable lane labels, not new permissions or authority.

Same-run summons are read-only sidecar calls attached to an existing run. A summon carries an explicit brief, kind such as `qa` or `critique`, optional one-call provider assignment, constraints, and artifact refs. The runtime records the handoff and provider artifacts, but the summoned agent does not advance the main state machine or gain edit authority. Model-backed summon providers still pass through provider-invocation approval; autopilot can auto-approve that bounded gate when policy allows it.

Same-run fan-out is a bounded group of summons attached to one run. The current runtime executes fan-out items sequentially so provider approval gates stay explicit and auditable, then writes a compact `fanout` artifact with item statuses, artifact refs, and bounds. Repo config can lower the fan-out item cap through `defaults.fanoutMaxItems`, while the runtime hard cap remains 8. Fan-out is an evidence fan-in surface, not a scheduler: grouped responses remain sidecar evidence and cannot satisfy required verifier or runtime QA/validation lanes.

Review lanes are runtime-derived gate metadata, not separate schedulers. The runtime derives verifier, runtime QA/validation, QA tester, and critic lanes from existing canonical evidence such as verifier responses, validation command artifacts, tool events, QA tester responses, critic responses, and read-only summon responses. Each lane carries bounded ownership metadata: owner label, role or runtime owner, provider/model assignment when known, required or optional status, current state, compact summary, and artifact/event refs. Final reports and progress packets expose those lanes so CLI, MCP, TUI, and future app surfaces can display reviewer/tester/QA/critic state without owning orchestration logic. A summoned agent can add read-only sidecar evidence, but a summon does not satisfy or replace a required verifier or runtime QA/validation lane.

Critic triggers are runtime decisions, not model decisions. When QA, verifier, or deterministic validation evidence indicates risk, the runtime can invoke the configured read-only critic and write a `critic_trigger` artifact with the reason code, source roles, evidence refs, and critic response ref. The critic can recommend revision or missing evidence, but it cannot edit, satisfy validation, approve completion, or replace verifier ownership.

Revision packets are runtime repair handoffs, not reviewer authority. When QA returns `needs_revision`, verifier returns `revise`, or critic returns `needs_revision`, the runtime writes a compact `revision_packet` artifact and moves the run back to `implementing` with that packet in the implementer directive context. The next QA/verifier pass must use fresh post-repair runtime evidence. Verifier `ask_user` or `abort`, protected test gates, unsafe critic feedback, max-iteration failures, and other hard policy gates still stop instead of silently revising.

Loop responsibility schedules are runtime-derived visibility snapshots over the same canonical evidence. A schedule names the current planner/orchestrator, implementer, verifier, runtime QA/validation, model-assisted QA tester, critic, reconciliation, integration, operator approval, and completion responsibilities with compact owner, status, gate, artifact, event, and handoff refs. The schedule does not add permissions, call providers, satisfy gates, or replace the state machine; it lets CLI, MCP, TUI, and future app surfaces show who owns the next responsibility without duplicating orchestration logic.

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

When `approvalPolicy.mode` is `autopilot`, the user has pre-authorized the runtime to approve bounded low-risk gates without another prompt. Autopilot may approve provider invocation, implementation start, external transfers that pass transfer-manifest policy, isolated patch application, and runtime-owned revision packet repair while the provider-call budget allows. It must still stop for secret-risk transfers, protected test/fixture/snapshot/eval changes, destructive or dependency/network commands that require explicit command approval, dirty-checkout integration blockers, max-iteration failures, verifier `ask_user` or `abort`, and unsafe critic outcomes.

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
- derived review ownership metadata for verifier, runtime QA/validation, model-assisted QA tester, critic, and read-only summon evidence
- critic trigger artifacts explaining why an advisory critic was called
- revision packet artifacts explaining why repair was delegated back to the implementer
- external transfer manifest artifacts before approved provider transfers
- typed handoff records for role delegation, approval mediation, and completion

Models may summarize evidence, but summaries are not authoritative.

## Memory

TheHood's memory is canonical runtime state, not provider session context. Exact artifacts, run records, command logs, diffs, approvals, verifier verdicts, and final reports are authoritative. Summaries, vector memories, graph memories, and model reflections are derived navigation layers.

Provider directives should assume that browser and API conversation context may be stale or empty. The runtime rehydrates providers from bounded packets that point back to exact artifacts.

Each provider directive includes a bounded `canonicalMemory` object. It is a refs-only project memory index containing the current run snapshot, recent run summaries, and latest progress packet, reconciliation, repo context, final report, and transfer manifest refs when available. It does not include large artifact bodies. Providers must treat this runtime-owned memory as authoritative and ignore stale provider session context unless that context is repeated in the directive.

## Final Reports

Completed read-only and verified implementation runs attach a `report` artifact with `kind: "final_report"`. The report includes the run goal, final state, stop reason, completing role, artifact refs, command metadata, approval events, and bounded review ownership lanes. The runtime also stores a bounded progress packet artifact after completion so a later planner reconciliation step can ask for external-transfer approval using an exact artifact ref.

Run status insights expose the latest progress packet, reconciliation, repo context, final report, and transfer manifest refs. They also expose bounded loop responsibility schedules and operator next actions derived by the runtime from run state, approvals, provider waits, terminal state, and review ownership lanes. Loop schedules and operator next actions are navigation aids over canonical artifacts; they do not replace artifact reads when a reviewer needs the full evidence and they do not weaken approval policy.

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
  -> mapped QA tester response
  -> critic response when runtime trigger policy detects QA, verifier, or validation risk
  -> revision packet and implementer repair pass when QA, critic, or verifier returns a fixable revision finding
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

For read-only runs, model-backed providers such as `chatgpt-web`, `claude-code`, and `codex-cli` require provider-invocation approval before the first provider call unless autopilot policy auto-approves that bounded gate. When a read-only orchestrator or planner returns `action: "delegate"` to a repo reader or inspector, the runtime treats that as an evidence request. For `chatgpt-web`, if local git reports a GitHub remote, a clean checkout, and `HEAD` matching the tracked upstream ref, the runtime can attach a refs-only `remote_context` artifact that instructs ChatGPT Web to use its GitHub connector at that exact commit instead of sending local file excerpts. Local runtime artifacts and checkout state remain authoritative, and the runtime falls back to deterministic local capture for local-only, dirty, unpushed, or non-ChatGPT providers. Local capture writes a bounded `repo_context` artifact using deterministic filesystem reads. For browser or API model providers such as `chatgpt-web`, `openai-api`, and `anthropic-api`, the runtime then writes a `transfer_manifest` artifact before sending local repo context back to the provider. Manual policy stops at a second approval gate; auto-low-risk transfer policy and autopilot can auto-approve bounded non-secret manifests while still recording the manifest, approval event, and `approval_auto_approved` event. If the role requests another delegation after a local context pack exists, the runtime captures a follow-up context only when the structured decision names concrete repo paths that were not already captured or were previously captured only as truncated excerpts. If the role requests another delegation after a remote connector context already exists, the runtime stops at an approval gate rather than looping. Provider directives rehydrate local repo context from all captured context artifacts, assembling continuation chunks into one ordered excerpt per path, and include any refs-only remote connector context separately. Broad or fully duplicate repeated evidence delegations still stop at an approval gate instead of looping indefinitely.

When a read-only orchestrator or planner returns `action: "delegate"` with `delegateTo: "implementer"` or `nextRole: "implementer"` and does not set `requiresMoreEvidence: true`, the runtime treats the response as a completed implementation handoff plan. A `plan` run then writes the usual final report and progress packet instead of recapturing repo context.
