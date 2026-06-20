# Model Selection

TheHood lets users assign a provider and model to each runtime role. Codex stays the operating surface, but the loop can use GPT, Claude, Codex, API, or local models according to the user's role map.

Every assignment uses:

```text
provider:model
```

Examples:

```bash
thehood roles set orchestrator chatgpt-web:chatgpt-pro --repo .
thehood roles set planner claude-code:opus --repo .
thehood roles set implementer claude-code:sonnet --repo .
thehood roles set qa codex-cli:spark --repo .
thehood roles set verifier claude-code:sonnet --repo .
thehood roles set critic claude-code:fable --repo .
```

## Selection Rules

- `codex-cli` discovers live model slugs from `codex debug models`.
- `claude-code` supports known aliases such as `sonnet`, `opus`, `haiku`, `mythos`, and `fable`, and passes explicit non-default names through to the local Claude CLI.
- `chatgpt-web` supports `chatgpt-pro` and `configured`; the user must select and confirm the intended ChatGPT model in the browser bridge path.
- `openai-api` and `anthropic-api` are future API providers. Their configs expose `configured` model slots, but the adapters are not implemented yet.
- `configured` means "use the provider's configured/default local selection" for local CLI providers.

The runtime should not hardcode a final model menu. Model catalogs change faster than TheHood releases. Built-in aliases are convenience labels; custom names remain valid when the user's configured provider supports them.

## Common Role Maps

Codex default:

```text
orchestrator: codex-cli:default
implementer: codex-cli:default
qa: codex-cli:spark
verifier: codex-cli:spark
critic: codex-cli:spark
```

Claude second judge:

```text
orchestrator: codex-cli:default
implementer: codex-cli:default
qa: codex-cli:spark
verifier: codex-cli:spark
critic: claude-code:sonnet
```

Spark plus Sonnet:

```text
orchestrator: codex-cli:default
implementer: codex-cli:spark
qa: codex-cli:spark
verifier: claude-code:sonnet
critic: claude-code:sonnet
```

Claude builder:

```text
orchestrator: codex-cli:default
implementer: claude-code:sonnet
qa: codex-cli:spark
verifier: codex-cli:spark
critic: codex-cli:spark
```

Pro plus Claude high assurance:

```text
orchestrator: chatgpt-web:chatgpt-pro
implementer: codex-cli:default
qa: codex-cli:spark
verifier: claude-code:sonnet
critic: claude-code:sonnet
```

## Runtime Boundaries

Provider choice does not grant authority. The runtime still owns approval gates, external transfer manifests, artifact storage, validation evidence, isolated patch integration, protected-path classification, and implementer/verifier separation.

Claude, Pro, GPT, Codex, and local agents can suggest, implement, review, or judge according to role. None of them can override runtime enforcement.
