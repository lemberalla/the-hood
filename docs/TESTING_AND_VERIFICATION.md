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
- Isolated implementer patches stop at an approval gate, then deterministic runtime integration applies the approved patch before verifier review.

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
