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
| Verifier | Validate output against acceptance criteria | No | Test/log tools only | Recommends approve/revise/abort |
| Critic | Find risks, missing cases, design flaws | No | Read-only | No |
| Integrator | Apply approved patches | Yes, deterministic | Limited | No |
| Citation Agent | Verify evidence and attribution | No | Read/search only | No |

## Hard Invariants

- Implementer and verifier cannot be the same agent for the same task.
- Verifier cannot edit files.
- Critic cannot edit files.
- Researcher cannot edit files.
- Integrator applies only approved patches.
- Runtime command logs beat model summaries.
- Test changes must be explicit and separately reviewed.

## Same-Run Summons

A summon is a runtime-owned read-only call to an existing role on an existing run. It is how the runtime can ask a planner, researcher, verifier, or critic to review a slice, perform QA, challenge assumptions, or gather evidence without changing the main loop owner.

Summons carry:

- role
- kind such as `review`, `qa`, `critique`, `research`, or `plan`
- brief and optional persona
- constraints
- artifact refs used as evidence
- optional one-call provider assignment

A summon does not grant edit tools, apply patches, accept work, or rewrite the run's role mapping. Model-backed summon providers still require provider-invocation approval unless autopilot policy auto-approves the bounded gate.

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
