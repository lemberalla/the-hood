# Product Roadmap

This roadmap turns provider-neutral model choice into product behavior without weakening runtime authority.

## Phase 1: Product Decision And Docs

- Position TheHood as a governed multi-model runtime for Codex.
- Document agent usage modes across Codex, Claude, Pro, API, and local providers.
- Document model selection and passthrough alias policy.
- Document role policy.
- Document configurable policy versus runtime invariants.
- Add concise UX copy for recommended, automatic, approval-required, and blocked provider paths.

Done means a user can understand which model is used, why it is recommended, and what it cannot override.

## Phase 2: UX And Audit Surface

- Add a mode selector.
- Add a model picker with provider:model assignments, known aliases, and custom passthrough entry.
- Show a compact "Why this agent?" explanation before or during Claude, Pro, or other provider use.
- Record provider usage as audit/timeline events.
- Show approval copy for sensitive or large context transfer.
- Expose settings for budgets, thresholds, role assignments, and redaction preferences.

Done means every model-backed call has a visible reason and a mode-derived policy basis.

## Phase 3: Runtime Policy Integration

- Map usage modes to runtime policy.
- Add escalation reason codes.
- Gate Claude, Pro, and API calls through provider readiness, host-policy preflight where applicable, and transfer policy.
- Preserve directive acknowledgement validation.
- Attach provider invocation and response artifacts for every model-backed call.
- Surface model policy as listed, discovered, or passthrough in doctor, roster, MCP, and settings views.

Done means model calls can be automatic where policy allows, but never hidden and never authoritative over runtime gates.

## Phase 4: Quality Loops

- Use Pro for reconciliation after agent disagreement.
- Use Claude as independent critic, verifier, or alternate implementer when configured.
- Use Pro critic or final review for strategic/product decisions.
- Use High Assurance final review for public or reputational work.
- Escalate to Pro after deadlock or repeated failure where configured.
- Escalate to Claude second judgment after Codex self-review risk, implementation risk, or user preference triggers.

Done means cross-model use reduces bad loops instead of adding another loop.

## Phase 5: Public Messaging

- Update README and public docs with the governed-runtime framing.
- Show examples for Efficient, Balanced, High Assurance, and Pro-led modes.
- Show examples for Claude second judge, Spark plus Sonnet, Claude builder, and Pro plus Claude high assurance.
- Explain evidence transfer, connector mode, and privacy boundaries.
- Keep "Codex can use Pro" and "Claude inside Codex" as capabilities, not authority claims.

Done means the short pitch is compelling and the trust model is inspectable.
