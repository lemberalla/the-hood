# Privacy

TheHood is a local runtime. By default, it stores runtime state, logs, artifacts, approvals, browser profile references, and configuration on the user's machine.

TheHood does not include hosted telemetry or a hosted service in this repository. Provider calls only happen when the user configures and approves a provider path, such as Codex CLI, Claude Code, ChatGPT Web, or a future API adapter.

Do not publish `.thehood/` state, provider logs, browser profiles, environment files, tokens, or private run artifacts. See `docs/SECURITY_AND_PRIVACY.md` for runtime security and data-boundary details.
