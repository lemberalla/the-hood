# Testing And Verification

Verification is an independent runtime phase, not an implementer self-report.

## Core Rule

The implementer and verifier cannot be the same agent for the same task.

Implementers may run tests for feedback, but their results are not authoritative until the runtime captures logs and a separate verifier reviews them.

## Responsibilities

### Implementer

May:

- run local checks for feedback
- report commands it ran
- report unresolved risks

Must not:

- mark its own work accepted
- edit tests to make its implementation pass without explicit approval
- hide failing commands

### Runtime

Must:

- run configured validation commands
- capture raw logs
- capture exit codes
- capture diffs before and after
- enforce protected path policies

Current implementation:

- `thehood exec <run-id> -- <command> [args...]` captures command logs as artifacts.
- `thehood evidence <run-id>` captures git status, git diff, and protected path matches.
- The verification phase discovers package validation scripts in `typecheck`, `test`, `lint`, `build` order, runs the first available script through the runtime command runner, and attaches a validation summary artifact before verifier review.
- Isolated implementer patches stop at an approval gate, then deterministic runtime integration applies the approved patch and writes an integration report before verifier review.
- Integrated patches that touch protected test, fixture, snapshot, or eval paths stop at a separate approval gate before verifier review.
- Completed runs attach a runtime-owned final report artifact with command, artifact, and approval refs.
- QA, verifier, or validation risk can cause the runtime to call a read-only critic and attach a `critic_trigger` artifact before continuing to verifier or an approval gate.
- Fixable QA, critic, or verifier revision findings can cause the runtime to attach a `revision_packet` artifact and delegate a repair pass back to the implementer within the same max-iteration budget.
- Completed runs and progress packets include derived review lane metadata for verifier, runtime QA/validation, QA tester, and critic evidence when present. They also include loop responsibility schedules that summarize planner, implementer, verifier, runtime QA, model-assisted QA tester, critic, reconciliation, integration, approval, and completion ownership from existing evidence. These lanes and schedules summarize existing runtime evidence; they do not schedule new work or replace verifier approval.
- Runs fail closed before the next provider call once recorded provider responses reach `maxIterations`.

### QA Tester

May:

- inspect runtime-captured evidence
- inspect diffs, plans, and provider artifacts
- identify missed cases and product risks
- recommend deterministic validation commands

Must not:

- edit files
- change tests
- claim a command passed unless the runtime captured it
- satisfy runtime QA/validation gates
- accept work on behalf of the verifier

### Verifier

Must:

- inspect runtime-captured evidence
- classify failures
- compare output against acceptance criteria
- recommend approve, revise, abort, or ask_user

Must not:

- edit files
- update tests
- apply patches

## Protected Test Paths

Default protected patterns:

```yaml
protected_test_paths:
  - "**/test/**"
  - "**/tests/**"
  - "**/*.spec.*"
  - "**/*.test.*"
  - "**/__snapshots__/**"
  - "**/fixtures/**"
  - "**/evals/**"
```

Changes under protected paths are classified as `TEST_CHANGE`.

A `TEST_CHANGE` requires:

- explicit reason
- separate approval
- verifier review
- final user-visible mention

## Verification Commands

The runtime should discover project commands from existing files before inventing commands.

Examples:

- `package.json`
- `pyproject.toml`
- `Cargo.toml`
- `Package.swift`
- `Makefile`
- CI configuration

The runtime should prefer existing project validation commands.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `approve` | Criteria satisfied, no blocking risk |
| `revise` | Fixable issue exists |
| `abort` | Task is unsafe, impossible, or outside scope |
| `ask_user` | Human decision required |

## Evidence Format

Verifier output should reference evidence:

```yaml
evidence:
  - kind: test_log
    ref: logs/run-123/npm-test.txt
    finding: "npm test passed with exit code 0"
  - kind: diff
    ref: diffs/run-123/iteration-2.patch
    finding: "Only src/export.ts changed"
```

## Anti-Patterns

- Same model edits and verifies.
- Verifier receives only the implementer's summary.
- Test files are silently modified.
- Final report says "tests passed" without command names and exit codes.
- Runtime applies an isolated patch before explicit approval.
- A same-run summon labeled `qa`, `review`, or `critique` is treated as satisfying a required verifier or QA gate.
- A same-run fan-out is treated as a scheduler, acceptance vote, or substitute for runtime validation.
- A model QA response is treated as proof that validation commands passed.
- A critic response is treated as proof that implementation is accepted or deterministic validation passed.
- A stale pre-revision verifier or validation result is treated as satisfying the post-repair review gate.
