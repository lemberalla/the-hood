# Known Limitations

TheHood `v0.1.0-preview.0` is a developer preview. It is meant to prove a local governed software goal-loop runtime, not the full long-term product.

## Not Built Yet

- No hosted runtime backend.
- No cloud routines, cron schedules, or overnight hosted automation.
- No timer-based `thehood schedule` surface.
- No full hosted web dashboard.
- No production OpenAI API adapter.
- No production Anthropic API adapter.
- No production local model adapter.
- No mature public loop library or preset marketplace.
- No polished macOS menubar app.
- No automatic native Codex visual rendering beyond explicit agent-board or dashboard artifact payloads.

## Experimental Surfaces

- ChatGPT Web bridge depends on a user-authenticated browser session and can break when ChatGPT UI behavior changes.
- ChatGPT MCP connector mode depends on custom connector/tunnel availability in the user's ChatGPT workspace.
- Local Codex CLI and Claude Code adapters depend on locally installed tools and their own provider access.
- The optional Codex plugin is an opt-in workflow helper, not a runtime authority.

## Operational Limits

- The runtime is local-first. If the machine sleeps, network access disappears, or the terminal session stops, local runs can stop.
- TheHood preserves evidence and artifacts, but users must still review private data before publishing a repo.
- The deterministic runtime can enforce local gates, but it cannot bypass Codex, ChatGPT, Claude, tenant, GitHub, or npm policy gates.
