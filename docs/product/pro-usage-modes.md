# Pro Usage Modes

Pro usage modes define the product's reasoning posture. They do not weaken runtime gates.

`Balanced` is the default mode.

| Mode | Posture | Pro is recommended when | Pro can be automatic when | Approval is needed when |
| --- | --- | --- | --- | --- |
| Efficient | Minimize premium usage. | Architecture, product, or planning ambiguity; repeated failure; risky judgment. | Deadlock, repeated failure, or explicit configured escalation. | Pro use is discretionary, context is sensitive, or budgets would be exceeded. |
| Balanced | Use Pro when it likely improves the outcome. | Planning, reconciliation, agent disagreement, high-risk refactors, release decisions. | Ambiguous planning, reconciliation after disagreement, high-impact docs or architecture review. | Context transfer is large or sensitive, or the action crosses runtime gates. |
| High Assurance | Optimize for correctness and public trust. | Public docs, release plans, security, privacy, positioning, pricing, migration plans. | Final plan review, release-risk review, unresolved QA/verifier conflict. | Any edit, dependency, network, protected-path, or sensitive-transfer gate. |
| Pro-led | Pro leads strategy while runtime controls mechanics. | Most planning, prioritization, critique, reconciliation, and final judgment. | Strategic phases and reconciliation by default. | Any mutation, risky external transfer, provider readiness issue, or policy override. |

## Recommendation Rules

The runtime should recommend Pro when one or more of these are true:

- The task is ambiguous and the next step is not obvious.
- Agents disagree or produce incompatible plans.
- The decision affects architecture, security, privacy, pricing, public messaging, or product trust.
- A prior loop failed, stalled, or returned low-confidence output.
- The result is user-facing or reputationally important.
- The runtime needs reconciliation across planner, implementer, QA, verifier, and critic output.

## Automatic Use

Automatic Pro calls are allowed only when the selected mode permits that class of escalation. Automatic does not mean hidden.

Every automatic Pro call must record:

- mode
- reason code
- role
- provider/model
- context source refs
- approval or auto-approval basis
- resulting artifact refs

User-facing copy should be short:

> Using Pro because this decision is ambiguous and affects product architecture. Runtime gates still control edits, approvals, evidence, and execution.

## Approval Rules

Approval is required for risk, not merely because Pro exists.

Require approval when:

- context is sensitive, unusually large, or external-transfer-bound
- configured Pro budgets, size limits, or frequency limits would be exceeded
- a provider bridge requires setup, authentication, or session handoff
- the task crosses edit, dependency, network, protected-path, or integration gates
- Efficient mode is active and Pro use is discretionary

Do not require a separate approval when:

- the selected mode permits the Pro call
- the call is planning or review only
- context stays inside configured low-risk limits
- the runtime records the provider invocation and artifacts

