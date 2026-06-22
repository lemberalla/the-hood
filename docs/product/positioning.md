# Positioning

TheHood gives Codex a governed runtime for using the best available model at each layer of an agent loop.

The runtime controls execution. Codex is the default workbench. Claude can be brought in as an independent second judge or preferred alternate worker. ChatGPT Pro can be used as visible premium strategic judgment when the work is ambiguous, high-value, reputational, or needs reconciliation.

## Core Claim

TheHood is not a hidden bridge that lets Codex silently spend another provider's reasoning. It is a local agent runtime that makes model choice visible, policy-driven, and auditable.

## Product Shape

- Runtime conductor: deterministic loop control, role separation, approvals, evidence, artifacts, and verification gates.
- Codex-first workbench: Codex remains the default control and implementation surface.
- User-controlled model roles: users can assign GPT, Claude, Codex, API, or local models to orchestrator, planner, implementer, QA, verifier, critic, and reconciliation roles.
- Claude second judge: Claude is a simple way to challenge Codex or Pro output with an independent model family, or to act as the user's preferred builder/reviewer.
- Visible Pro escalation: Pro is used deliberately for strategic planning, product judgment, reconciliation, critique, and high-reputation review.
- Connector fallback: when direct Pro calls are blocked by Codex or tenant host policy, ChatGPT MCP connector mode is the safe handoff path.
- Trusted MCP host preview: ChatGPT Developer Mode can reach a local TheHood MCP server through Secure MCP Tunnel, while TheHood still owns repo access, approvals, logs, and verification gates.

## Tradeoff

The original pitch, "Codex can use ChatGPT Pro," is simple and compelling. It is also too easy to misread as Pro being the hidden conductor and too narrow for users who want Claude, GPT, and Codex in the same workflow.

The stronger pitch is more precise:

- The runtime executes and enforces.
- Users choose model owners per role.
- Claude can challenge, verify, or implement by user preference.
- Pro advises and judges when premium strategic reasoning is worth it.
- Users can see which model was used, why it was recommended, and whether it was automatic.

This is slightly less viral than the original pitch, but it is more trustworthy and easier to defend for serious software work.

## User-Facing Line

Use TheHood when you want Codex to become a governed multi-model workbench: Codex builds, Claude can second-judge or assist, Pro can approve strategy, and the runtime enforces the loop.
