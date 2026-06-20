# Runtime Invariants

Configuration changes how TheHood chooses providers and when it escalates. It does not change the trust boundary.

## Configurable Policy

Users and repos may configure:

- default Pro usage mode
- role-to-provider assignments
- Pro escalation thresholds
- automatic Pro call budget, frequency, and context size
- phases that can use Pro automatically
- evidence redaction preferences
- path sensitivity labels
- external transfer policy within runtime limits
- user-facing verbosity for Pro explanations
- whether Pro usage appears as a banner, timeline event, or compact audit entry

## Non-Configurable Runtime Enforcement

These are runtime invariants:

- The runtime owns loop control.
- The runtime owns approval enforcement.
- The runtime validates provider responses and directive acknowledgements.
- The runtime records artifacts, evidence refs, and provider invocation metadata.
- The runtime enforces edit, shell, dependency, network, external-transfer, and protected-path gates.
- The runtime rejects stale provider-session responses.
- Models cannot grant themselves permissions.
- Implementer and verifier authority remain separate.
- Runtime-captured command evidence beats model summaries.
- Provider choice cannot make a protected path unprotected.
- Pro cannot bypass Codex or tenant host policy.
- Connector mode is a safe handoff path, not a host-policy bypass.

## Final Approval Boundary

Pro can be configured as the final strategic approver for a product or architecture slice. That means Pro gives the last model-backed judgment on direction and quality.

Final strategic approval is not final runtime authority. The runtime still decides whether required gates are satisfied and whether evidence is complete.

