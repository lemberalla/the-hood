# Loop Recipes

Loop recipes are repeatable patterns over roles, validation, budgets, and stop conditions. They are not a separate scheduler and they do not grant new authority.

Users should not have to choose a recipe ID first. Use `thehood recommend-loop` or the MCP `thehood_recommend_loop` tool to route a plain-language goal into one of these recipes, draft a completion contract, and show alternatives.

## Build, Test, Fix

Status: available through the existing goal loop.

Use when a code change has a clear acceptance test.

Command shape:

```bash
thehood goal "fix the failing checkout test" --repo . --max-iterations 5
```

Roles involved:

- Planner or orchestrator defines the scoped implementation.
- Implementer edits only allowed paths.
- Runtime captures diff and validation logs.
- QA tester is advisory when routing requires it.
- Verifier approves or returns fixable findings.

Required evidence:

- scoped diff
- runtime-captured validation command logs
- review routing artifact
- verifier verdict

Stop conditions:

- verifier approves
- manual approval is required
- max iterations reached
- unsafe or unresolved blocker

Risks:

- scope grows beyond the goal
- validation command is missing
- protected test, fixture, snapshot, or eval changes appear without approval

## Verifier Loop

Status: available through the existing verification lane.

Use when correctness matters more than speed.

Command shape:

```bash
thehood goal "prove the release metadata is correct" --repo . --max-iterations 5
```

Roles involved:

- Runtime captures validation evidence.
- Verifier reviews independently from the implementer.
- Verifier can approve, revise, abort, or ask the user.

Required evidence:

- acceptance criteria
- runtime-captured command evidence
- diff evidence
- verifier verdict

Stop conditions:

- verifier approves
- verifier asks the user
- verifier aborts
- max iterations reached

Risks:

- accepting model summaries instead of raw evidence
- letting the same authority implement and verify

## Anti-Spin

Status: partial. Max-iteration enforcement exists; richer spin detection is future work.

Use when a task is prone to endless model retries.

Command shape:

```bash
thehood goal "repair the flaky smoke test" --repo . --max-iterations 3
```

Roles involved:

- Runtime enforces budgets and provider response state.
- Orchestrator must request concrete evidence instead of vague retries.
- Verifier or operator decides when repeated failure needs a human.

Required evidence:

- last failed evidence
- repeated-failure signal
- budget state
- stop reason

Stop conditions:

- max iterations reached
- same validation failure repeated
- same verifier rejection repeated
- no diff change after repair attempt
- flip-flop between two approaches
- duplicate evidence request
- provider response blocked or failed
- schema validation repeatedly fails
- protected-path approval required
- unsafe critic finding

Risks:

- stopping too late
- reporting exhaustion as success
- repeatedly asking for the same context

## Completion Contract

Status: partial. Contract docs and recommendation drafts exist; first-class contract artifacts are future work.

Use before public release, packaging, security, privacy, docs, or risky repo tasks where "done" must be explicit.

Command shape:

```bash
thehood recommend-loop "prepare public preview release" --repo . --max-iterations 5
```

Roles involved:

- Orchestrator or planner defines the contract.
- Implementer follows allowed paths and forbidden changes.
- Runtime captures validation evidence.
- QA tester and critic can provide advisory evidence.
- Verifier checks the contract against runtime evidence.

Required evidence:

- goal
- acceptance criteria
- allowed paths
- forbidden changes
- validation commands
- required evidence
- reviewer roles
- iteration budget
- stop conditions

Stop conditions:

- all required evidence is proved
- required evidence is weak or missing
- approval boundary
- max iterations reached

Risks:

- vague acceptance criteria
- missing forbidden changes
- partial completion reported as done

## Quality Streak

Status: planned. For `v0.1.0-preview.0`, represent this as manual repeated goals or explicit validation, not an automatic streak runner.

Use when one green validation run is not enough, especially for flaky or stability-sensitive work.

Future command shape:

```bash
thehood goal "stabilize checkout flow" --repo . --recipe quality-streak --streak 10
```

Required evidence:

- same validation command repeated under recorded conditions
- streak count
- failure reset evidence

Stop conditions:

- target streak reached
- failure resets streak
- budget exhausted
- approval required

Risks:

- expensive repeated validation
- overfitting to one scenario
- claiming streak support before it is implemented

## Adversarial Review

Status: partial. Same-run summons and fan-out exist as advisory sidecar evidence; recipe presets are future work.

Use when product, architecture, security, UX, or release risk is high.

Command shape:

```bash
thehood summon <run-id> --role critic --brief "Challenge this plan"
```

Roles involved:

- Critic challenges the plan or patch.
- QA tester may look for missed cases.
- Verifier remains the required acceptance lane.

Required evidence:

- critic response
- runtime validation evidence
- verifier verdict

Stop conditions:

- critic finds no blocking concern and verifier approves
- fixable critique becomes revision packet
- unsafe critic finding
- approval required

Risks:

- treating sidecar critique as acceptance
- reviewing an old version after edits
- claiming multi-model consensus without genuinely separate model families

Important rule:

```text
Adversarial review is evidence, not acceptance.
Only runtime validation plus verifier review can satisfy completion.
```

## Human Approval Queue

Status: available through existing approval gates.

Use when work crosses data, permission, protected-path, external-transfer, dependency, network, or integration boundaries.

Command shape:

```bash
thehood approvals policy show --repo .
```

Loop shape:

```text
Run task
Pause at approval gate
User chooses approve / revise / reject / abort
On revise, create a revision packet when appropriate
On approve, integrate or continue
On reject or abort, stop safely
```

Required evidence:

- approval reason
- relevant artifact refs
- operator decision
- resume event

Stop conditions:

- user approves
- user revises
- user rejects
- user aborts
- approval remains pending

Risks:

- approval fatigue
- unclear reason copy
- manual copy-paste loops
