# Role Contracts

Role contracts define what each agent is responsible for, what it may access, and what it must return.

The same model provider can fill different roles across different runs, but a single agent instance must not hold conflicting powers inside the same run.

## Role Matrix

| Role | Responsibility | Edit Tools | Shell Tools | Acceptance Power |
| --- | --- | --- | --- | --- |
| Orchestrator | Plan, delegate, compare evidence, control loop | No by default | Limited | No final authority without evidence |
| Planner | Create implementation plan and risks | No | Read-only | No |
| Researcher | Inspect repo, docs, logs, and external references | No | Read/search only | No |
| Implementer | Make scoped code changes | Yes, scoped | Yes, scoped | No |
| QA Tester | Find missed cases and recommend validation from evidence | No | Read-only | No |
| Verifier | Validate output against acceptance criteria | No | Test/log tools only | Recommends approve/revise/abort |
| Critic | Find risks, missing cases, design flaws | No | Read-only | No |
| Integrator | Apply approved patches | Yes, deterministic | Limited | No |
| Citation Agent | Verify evidence and attribution | No | Read/search only | No |

## Hard Invariants

- Implementer and verifier cannot be the same agent for the same task.
- Verifier cannot edit files.
- QA tester cannot edit files.
- Critic cannot edit files.
- Researcher cannot edit files.
- Integrator applies only approved patches.
- Runtime command logs beat model summaries.
- Test changes must be explicit and separately reviewed.

## Same-Run Summons

A summon is a runtime-owned read-only call to an existing role on an existing run. It is how the runtime can ask a planner, researcher, QA tester, verifier, or critic to review a slice, perform QA, challenge assumptions, or gather evidence without changing the main loop owner.

Summons carry:

- role
- kind such as `review`, `qa`, `critique`, `research`, or `plan`
- brief and optional persona
- constraints
- artifact refs used as evidence
- optional one-call provider assignment

A summon does not grant edit tools, apply patches, accept work, or rewrite the run's role mapping. Model-backed summon providers still require provider-invocation approval unless autopilot policy auto-approves the bounded gate.

Summon responses can appear as read-only sidecar evidence on review ownership lanes. They are useful for QA, critique, and second opinions, but they cannot satisfy required verifier ownership, replace runtime-captured validation evidence, or advance the main state machine.

## Review Ownership

Review ownership is derived by the runtime from canonical run evidence. A lane records the owner, provider/model assignment when the owner is a role, whether the lane is required, whether its evidence can satisfy required gates, and compact artifact/event refs.

- Verifier ownership is satisfied only by a main verifier response under the runtime loop.
- Runtime QA/validation ownership is satisfied only by runtime-captured validation evidence and command metadata.
- QA tester ownership is advisory model evidence and cannot satisfy runtime validation.
- Critic ownership is advisory unless the runtime explicitly enters a critic-controlled path.
- Same-run summons are sidecar evidence and remain read-only.

## Orchestrator

The orchestrator owns the strategy, not the filesystem.

Inputs:

- user goal
- repo context
- constraints
- role mapping
- current state
- worker results
- verifier verdicts
- critic feedback
- budgets

Allowed tools:

- read run state
- create plan
- delegate task
- request approval
- ask for verification
- ask for critique

Disallowed by default:

- direct file edits
- direct shell commands
- direct patch application

Outputs:

- plan
- task assignments
- approval request
- continue/revise/abort decision
- final synthesis

## Implementer

The implementer owns scoped changes.

Inputs:

- narrow task objective
- allowed paths
- relevant files
- acceptance criteria
- disallowed changes
- testing hints

Allowed tools:

- read files
- edit allowed files
- run scoped commands
- inspect diff

Disallowed by default:

- changing protected test assets without explicit approval
- changing unrelated files
- applying its own output to the final checkout
- claiming acceptance

Outputs:

- changed files
- diff summary
- commands run
- self-check notes
- unresolved risks

## QA Tester

The QA tester is a read-only model-assisted tester, usually a cheaper model such as Codex Spark.

Inputs:

- user goal
- current plan
- diff summaries
- runtime command metadata
- validation artifacts
- verifier or critic evidence when present

Allowed tools:

- read files
- inspect diffs
- inspect logs
- recommend deterministic validation commands

Disallowed:

- editing files
- changing tests
- running or claiming command results unless the runtime captured them
- satisfying runtime QA/validation gates
- accepting work

Outputs:

- verdict: `pass`, `needs_revision`, `needs_more_evidence`, or `blocked`
- missed cases
- suggested validation commands
- product or regression risks
- summary grounded in runtime evidence

## Verifier

The verifier owns independent assessment.

Inputs:

- user goal
- acceptance criteria
- diff
- changed files
- raw test logs
- runtime command metadata
- implementer notes

Allowed tools:

- read files
- inspect diffs
- inspect logs
- request deterministic commands through runtime

Disallowed:

- editing files
- changing tests
- applying patches
- accepting unverifiable claims

Outputs:

- verdict: `approve`, `revise`, `abort`, or `ask_user`
- evidence
- failed criteria
- recommended next action

## Critic

The critic challenges the plan or patch.

Best used for:

- high-risk tasks
- architectural changes
- security-sensitive work
- unclear product behavior
- provider disagreement

Outputs:

- risks
- missing cases
- alternate designs
- blocking concerns
- non-blocking concerns

## Integrator

The integrator applies approved changes.

The integrator should be deterministic runtime code when possible, not a general model agent.

Responsibilities:

- apply approved patch
- verify target checkout state
- ensure no unrelated files are included
- capture final diff
