# Contributing

TheHood is starting documentation-first because the safety model matters as much as the code.

## Before Opening A Change

- Read the architecture and role-contract docs.
- Keep changes narrow.
- Explain changes to runtime permissions, provider adapters, or verification behavior clearly.
- Do not mix unrelated concerns in one change.

## Project Boundaries

Runtime logic belongs in the runtime.

Control surfaces should trigger runtime actions:

- CLI
- MCP server
- macOS menubar app

They should not independently implement orchestration policy, role permissions, test gates, or patch integration.

## Security Expectations

Never include:

- API keys
- browser cookies
- provider session tokens
- personal browser profiles
- private repo logs
- private customer or payment data

Use synthetic fixtures for examples.

## Verification Expectations

Changes that affect runtime behavior should include evidence from the relevant validation command once the project has an implementation and test setup.

The implementer and verifier should be different agents or different review phases.

