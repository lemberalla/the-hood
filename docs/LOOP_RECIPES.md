# Loop Recipes

Loop recipes are repeatable patterns over roles, validation, budgets, and stop conditions. They are not a separate scheduler.

## Build, Test, Fix

Use when a code change has a clear acceptance test.

- Planner defines the scoped implementation.
- Implementer edits only allowed paths.
- Runtime captures validation command evidence.
- Verifier approves or returns fixable findings.
- Revision packet routes a repair pass when appropriate.

## Verifier Loop

Use when correctness matters more than speed.

- Keep verifier assigned to a different provider/model authority than implementer.
- Require runtime-captured command logs.
- Treat verifier `ask_user` and `abort` as stop conditions.

## Anti-Spin Loop

Use when a task is prone to endless model retries.

- Set a low max iteration budget.
- Require concrete evidence requests.
- Stop on duplicate evidence delegation or vague "needs more context" loops.
- Fail closed when max iterations are reached.

## Completion Contract

Use before any public release, packaging, or risky repo task.

- Define allowed paths.
- Define forbidden changes.
- Define validation commands.
- Define evidence required in the final report.

## Quality Streak

Future pattern for repeated validation across several runs. In `v0.1.0-preview.0`, represent this as manual repeated goals rather than a scheduler.

## Adversarial Review

Use when product or security risk is high.

- Ask a read-only critic to challenge the plan or patch.
- Treat critic evidence as advisory.
- Convert fixable findings into runtime-owned revision packets.
- Do not let the critic satisfy verifier or validation gates.

## Human Approval Queue

Use when work crosses data, permission, or protected-path boundaries.

- Surface the exact reason and required approval phrase.
- Link the relevant manifest, diff, or artifact.
- Resume with `approval=approve`, `approval=reject`, or `approval=revise` only after the user decides.
