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
```

Each provider call is preceded by a runtime-built directive artifact containing role instructions, prompt variables, tool permissions, and the expected output contract. The provider response must satisfy that contract before the runtime advances to the next state.

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
- sending runtime-captured repo context to browser or API model providers such as `chatgpt-web`
- applying a worker patch to the main checkout
- continuing to verification after an applied worker patch changes protected test, fixture, snapshot, or eval paths
- switching orchestrator or verifier mid-run for an active task

When an approval reason includes an exact phrase such as `Approval message must mention "apply isolated patch"`, the runtime enforces that phrase before recording an approving transition.

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

Models may summarize evidence, but summaries are not authoritative.

## Final Reports

Completed read-only and verified implementation runs attach a `report` artifact with `kind: "final_report"`. The report includes the run goal, final state, stop reason, completing role, artifact refs, command metadata, and approval events.

Provider status is also authoritative. A worker response with `blocked` pauses at an approval gate. A worker response with `failed` fails the run. The runtime must not advance blocked or failed implementation into verification.

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
  -> verifier response
  -> verifier response schema validation
  -> completed or awaiting_approval
```

ChatGPT Web is wired through a user-configured bridge command. API model providers are not wired yet. Local Codex CLI and Claude Code adapters are available through the same directive and response-validation contract.

Read-only runs can also execute a mapped guest role directly:

- `plan` uses `planner` when assigned, otherwise `orchestrator`
- `research` uses `researcher` when assigned, otherwise `orchestrator`
- `review` uses `critic` when assigned, otherwise `orchestrator`

For read-only runs, model-backed providers such as `chatgpt-web`, `claude-code`, and `codex-cli` require an explicit provider-invocation approval before the first provider call. When a read-only orchestrator or planner returns `action: "delegate"` before repo context exists, the runtime captures a bounded `repo_context` artifact using deterministic filesystem reads. For browser or API model providers such as `chatgpt-web`, the runtime then stops at a second approval gate before sending that context back to the provider. If the role requests another delegation after a context pack exists, the runtime stops at an approval gate instead of looping indefinitely.
