# Role Policy

TheHood separates authority from judgment. Models can advise, plan, implement, or review according to their role. The runtime decides what is allowed.

## Runtime Conductor

The runtime is the mechanical conductor.

It owns:

- loop control
- role assignment and role separation
- stop conditions
- permission checks
- approval gates
- evidence capture
- artifact storage
- schema validation
- provider readiness checks
- directive acknowledgement validation
- integration and protected-path policy

The runtime does not delegate these responsibilities to Pro, Codex, Claude, or any other provider.

## Strategic Pro Conductor

Pro is a premium strategic reviewer and planner. It can be the final strategic approver for product direction, architecture judgment, reconciliation, or high-reputation review.

It owns:

- ambiguous planning
- product and architecture judgment
- reconciliation across conflicting agent outputs
- critique of a proposed direction
- high-reputation narrative review
- recommendations to continue, revise, delegate, verify, or abort

It does not own:

- file edits
- shell execution
- dependency installation
- network permission decisions
- approval bypasses
- artifact authority
- protected-path decisions
- runtime loop termination outside the provider response contract

## Claude Second Judge

Claude is an independent model-family reviewer or preferred alternate worker. It is not positioned as a backup to GPT. It is the user's way to bring Claude into the Codex workflow when a second judgment, different reasoning style, or Claude-led implementation is useful.

It owns, when assigned:

- contrarian critique of Codex or Pro output
- independent verifier review when Codex implemented the change
- implementation when the user prefers Claude Code for the build lane
- product, architecture, writing, or cautious reasoning review
- high-assurance cross-checks before final strategic approval

It does not own:

- approval bypasses
- final runtime authority
- protected-path decisions
- test acceptance without runtime evidence
- verifier authority when it was also the implementer for the same task

## Planner

The planner creates small, reversible execution paths. It separates facts from assumptions, names risks, defines acceptance criteria, and requests bounded evidence only when needed.

## Implementer

The implementer executes the approved slice with minimal scope. It must not reinterpret product strategy unless the plan is impossible, unsafe, or contradicted by repository evidence.

## QA Tester

The QA tester is read-only advisory review. It finds missed cases and recommends deterministic validation, but it does not satisfy runtime validation gates.

## Verifier

The verifier checks runtime-captured evidence against acceptance criteria. It has no edit tools and cannot replace runtime command evidence.

When Pro, Claude, Codex, or another provider is assigned as verifier, it is the reviewer for that slice. It still cannot bypass runtime enforcement.

## Critic

The critic challenges product, safety, architecture, and UX assumptions. Critic output can trigger revision, but it cannot approve integration or replace verification.
