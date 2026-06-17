# TheHood Agent Instructions

These instructions apply to agent work inside this repository.

## Read First

Before implementation work, read:

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/ROLE_CONTRACTS.md`
- `docs/RUNTIME_LOOP.md`
- `docs/SECURITY_AND_PRIVACY.md`
- `docs/TESTING_AND_VERIFICATION.md`

## Core Invariants

- Models suggest; runtime enforces.
- Implementer and verifier must not be the same agent for the same task.
- Verifier and critic roles must not receive edit tools.
- Test, fixture, snapshot, and eval changes require explicit classification and approval.
- The CLI, MCP server, and macOS app are control surfaces. They must not duplicate runtime logic.
- Provider adapters normalize behavior into TheHood schemas. They must not bypass runtime permissions.

## Development Rules

- Keep implementation changes minimal and directly related to the active task.
- Prefer typed schemas for cross-agent and provider boundaries.
- Prefer small single-purpose modules.
- Do not hardcode personal local paths.
- Do not commit secrets, browser profiles, provider tokens, or private run logs.
- Do not add dependencies without updating the project package config.
- Do not introduce frontend-owned orchestration logic.

## Verification Rules

- Use existing project validation commands once they exist.
- Capture command names, cwd, exit codes, and relevant output.
- Do not treat implementer-run tests as final verification.
- Document any skipped validation and why it was skipped.

