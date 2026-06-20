# Agent Usage Modes

Agent usage modes define the product's reasoning posture. They decide when to recommend Codex-only work, Claude second judgment, Pro strategic judgment, or a high-assurance combination. They do not weaken runtime gates.

`Balanced` is the default mode.

| Mode | Posture | Claude is recommended when | Pro is recommended when | Automatic use can happen when | Approval is needed when |
| --- | --- | --- | --- | --- | --- |
| Efficient | Minimize premium and cross-model usage. | User explicitly asks, a loop repeats, or Codex/Spark output needs a quick second judge. | Architecture, product, or planning ambiguity; repeated failure; risky judgment. | Deadlock, repeated failure, or explicit configured escalation. | External transfer is sensitive, budgets would be exceeded, or use is discretionary. |
| Balanced | Use the model that likely improves the outcome. | Codex implemented a risky change, agents disagree, or the user asks for Claude in Codex. | Planning, reconciliation, agent disagreement, high-risk refactors, release decisions. | Low-risk configured Claude review, ambiguous planning, or reconciliation after disagreement. | Context transfer is large or sensitive, or the action crosses runtime gates. |
| High Assurance | Optimize for correctness and public trust. | Public docs, release plans, security, privacy, architecture, migration, or high-risk implementation review. | Final strategic plan review, release-risk review, unresolved QA/verifier conflict. | Claude critic/verifier before final strategic approval, and Pro final review when configured. | Any edit, dependency, network, protected-path, or sensitive-transfer gate. |
| Pro-led | Pro leads strategy while runtime controls mechanics. | Red-team Pro plans, verify Codex implementation, or act as the user's preferred alternate worker. | Most planning, prioritization, critique, reconciliation, and final judgment. | Strategic phases, Claude red-team review, and reconciliation by default. | Any mutation, risky external transfer, provider readiness issue, or policy override. |

## Recommendation Rules

The runtime should recommend Claude when one or more of these are true:

- The user wants to use both Claude and GPT inside the Codex workflow.
- Codex or Pro produced the plan and an independent model-family critique would reduce risk.
- Codex implemented a risky change and the verifier should be different.
- The user prefers Claude for implementation, writing, cautious reasoning, or review.
- The task calls for a second judge but not full premium strategic approval.

The runtime should recommend Pro when one or more of these are true:

- The task is ambiguous and the next step is not obvious.
- Agents disagree or produce incompatible plans.
- The decision affects architecture, security, privacy, pricing, public messaging, or product trust.
- A prior loop failed, stalled, or returned low-confidence output.
- The result is user-facing or reputationally important.
- The runtime needs reconciliation across planner, implementer, QA, verifier, and critic output.

## Automatic Use

Automatic model calls are allowed only when the selected mode permits that class of escalation. Automatic does not mean hidden.

Every automatic model call must record:

- mode
- reason code
- role
- provider/model
- context source refs
- approval or auto-approval basis
- resulting artifact refs

User-facing copy should be short:

> Bringing in Claude because Codex produced the implementation and this review needs an independent model family. Runtime gates still control edits, approvals, evidence, and execution.

> Using Pro because this decision is ambiguous and affects product architecture. Runtime gates still control edits, approvals, evidence, and execution.

## Approval Rules

Approval is required for risk, not merely because Claude or Pro exists.

Require approval when:

- context is sensitive, unusually large, or external-transfer-bound
- configured provider budgets, size limits, or frequency limits would be exceeded
- a provider bridge requires setup, authentication, or session handoff
- the task crosses edit, dependency, network, protected-path, or integration gates
- Efficient mode is active and cross-model use is discretionary

Do not require a separate approval when:

- the selected mode permits the provider call
- the call is planning or review only
- context stays inside configured low-risk limits
- the runtime records the provider invocation and artifacts
