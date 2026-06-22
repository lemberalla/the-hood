# Provider Matrix

TheHood is provider-neutral at the runtime boundary, but provider support is intentionally uneven in the public preview. This matrix describes what is wired today versus what is only represented in config for future adapters.

| Provider | Status | Access Mode | Notes |
| --- | --- | --- | --- |
| `stub` | Implemented | local deterministic | Used by smoke tests and synthetic demos. Does not call external models. |
| `codex-cli` | Implemented | local command agent | Runs the local Codex CLI through TheHood's directive and response contract. Codex model discovery depends on the local CLI. |
| `claude-code` | Implemented | local command agent | Runs Claude Code through the same local command adapter boundary. Model aliases are pass-through to the user's installed tool. |
| `chatgpt-web` | Experimental, user-configured | browser agent bridge | Uses a user-authenticated ChatGPT Web session through the bridge command. It must be explicitly configured and remains sensitive to ChatGPT UI/session behavior. |
| `chatgpt-atlas` | Experimental, enabled by default and setup-gated | Computer Use agent bridge | Uses the packaged `thehood-chatgpt-atlas-bridge`, which delegates real desktop control to a trusted local Computer Use controller for a user-selected ChatGPT Atlas window. The runtime still owns approvals, provider waits, transfer manifests, and response validation. |
| ChatGPT MCP connector | Experimental, optional | external MCP host | ChatGPT may connect to TheHood through a trusted MCP host such as Secure MCP Tunnel when the user's workspace exposes custom connectors. This is not a launch blocker. |
| `openai-api` | Planned, not wired | future API agent | API key names and provider config are represented, but no production OpenAI API adapter is implemented in this preview. |
| `anthropic-api` | Planned, not wired | future API agent | API key names and provider config are represented, but no production Anthropic API adapter is implemented in this preview. |
| local model | Planned, not wired | future local agent | Local model ownership is a product goal, not a current runtime adapter. |

## Policy

- Provider adapters normalize model behavior into TheHood schemas.
- Provider adapters must not bypass runtime permissions, approval gates, transfer manifests, or verification.
- Model aliases are user preference only. They do not bypass provider availability, local command readiness, or runtime review.
- External browser/API provider transfers require manifest and approval policy before local repo context or memory leaves the machine.
