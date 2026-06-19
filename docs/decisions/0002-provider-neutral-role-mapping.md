# 0002: Provider Neutral Role Mapping

## Status

Accepted

## Context

Users should be able to choose which model performs which role. Codex is the default role owner for new repos, but ChatGPT Pro may orchestrate one run, while Claude Opus, Fable, or another provider may orchestrate the next when the user configures it.

## Decision

TheHood will use provider-neutral role mapping.

Each role is assigned by provider and model:

```yaml
roles:
  orchestrator:
    provider: codex-cli
    model: default
  implementer:
    provider: codex-cli
    model: default
  qa:
    provider: codex-cli
    model: spark
  verifier:
    provider: codex-cli
    model: spark
  critic:
    provider: codex-cli
    model: spark
```

Provider adapters normalize requests and responses into TheHood schemas.

## Consequences

- GPT, Claude, Codex, Claude Code, and local models can collaborate.
- Provider-specific behavior is isolated.
- Role contracts stay stable even as providers change.
- Users can swap orchestrators or workers without changing runtime logic.
