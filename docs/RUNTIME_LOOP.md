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
- user aborts the run

## Approval Gates

User approval is required before:

- editing files in a target repo unless the run mode already authorizes it
- modifying tests, fixtures, snapshots, or evaluation files
- installing dependencies
- running commands with external side effects
- using network access when the policy requires approval
- applying a worker patch to the main checkout
- switching orchestrator or verifier mid-run for an active task

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

Models may summarize evidence, but summaries are not authoritative.

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

Implementers can produce patches. They do not get to self-merge.
