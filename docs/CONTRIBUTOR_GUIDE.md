# Contributor Guide

TheHood is a local runtime for governed software agent loops. Public contributions should preserve the runtime trust model before adding new surfaces.

## Local Setup

```bash
npm ci
npm run build
node dist/cli/main.js doctor --repo .
node dist/cli/main.js roster --repo .
```

## Validation

Run the smallest relevant checks while developing. Before release-sensitive changes, run:

```bash
npm run typecheck
npm run build
npm run smoke:mcp
npm run smoke:codex-config
npm run smoke:runtime
git --no-pager diff --check
```

Use `npm run release:check` before packaging or release changes.

## Forbidden Content

Do not commit:

- `.thehood/` runtime state
- provider transcripts
- browser profiles
- cookies or session tokens
- API keys
- local `.env` files
- private prompts
- private repo data
- generated package archives
- real customer or payment data

Examples, demos, fixtures, and screenshots must be synthetic or scrubbed.

## Runtime Boundaries

- Runtime logic belongs in `src/runtime`.
- Provider adapters normalize external behavior into TheHood schemas.
- CLI, MCP, TUI, website, and future app surfaces should trigger runtime actions, not duplicate orchestration policy.
- Implementer and verifier must stay separate for implementation work.
- Verifier, QA tester, critic, and researcher roles must not receive edit tools.
- Protected test, fixture, snapshot, and eval changes require explicit classification and review.

## Provider Changes

Provider adapter proposals should explain:

- provider mode
- auth and secret storage
- output schema mapping
- approval gates
- transfer manifests
- fail-closed behavior
- validation plan
- docs updates

## Docs Changes

Docs should describe current state, not aspirational behavior. When a feature is planned or experimental, say so directly.
