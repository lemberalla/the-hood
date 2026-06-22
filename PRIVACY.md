# Privacy

TheHood is a local runtime. By default, it stores runtime state, logs, artifacts, approvals, browser profile references, and configuration on the user's machine.

TheHood does not include hosted telemetry or a hosted service in this repository. Provider calls only happen when the user configures and approves a provider path, such as Codex CLI, Claude Code, ChatGPT Web, or a future API adapter.

## What Stays Local

- `.thehood/` runtime state
- run records
- approval events
- command logs
- git evidence
- provider directives and responses
- final reports and progress packets
- local provider config
- browser profile references

The public package and repository should not include local `.thehood` state or private run artifacts.

## What Can Leave The Machine

Data can leave the machine only when the user configures a provider path or MCP host that receives it. Examples:

- Codex CLI or Claude Code receives a runtime-built directive through the local command adapter.
- ChatGPT Web receives a browser-bridge directive after provider invocation and transfer approval policy allow it.
- A future API adapter may receive a transfer manifest-approved packet.
- ChatGPT MCP connector mode may receive bounded TheHood tool results through the connected MCP host.

External transfers of local repo context, progress packets, or memory bodies must go through TheHood's transfer-manifest and approval policy.

## What Not To Publish

Never publish:

- API keys
- browser cookies
- OAuth credentials
- provider session tokens
- personal browser profiles
- `.thehood/` state
- provider logs
- private prompts
- private repo diffs or artifacts
- environment files
- generated package archives
- real customer, payment, or private project data

Use synthetic examples and fixtures. See `docs/SECURITY_AND_PRIVACY.md` and `docs/TRUST_MODEL.md` for runtime security and data-boundary details.
