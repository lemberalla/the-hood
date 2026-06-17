# 0002: Provider Neutral Role Mapping

## Status

Accepted

## Context

Users should be able to choose which model performs which role. ChatGPT Pro may orchestrate one run, while Claude Opus or another provider may orchestrate the next.

## Decision

TheHood will use provider-neutral role mapping.

Each role is assigned by provider and model:

```yaml
roles:
  orchestrator:
    provider: chatgpt-web
    model: chatgpt-pro
  implementer:
    provider: codex-cli
    model: default
  verifier:
    provider: anthropic-api
    model: claude-opus
```

Provider adapters normalize requests and responses into TheHood schemas.

## Consequences

- GPT, Claude, Codex, Claude Code, and local models can collaborate.
- Provider-specific behavior is isolated.
- Role contracts stay stable even as providers change.
- Users can swap orchestrators or workers without changing runtime logic.

