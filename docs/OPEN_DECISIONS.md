# Open Decisions

These decisions should be resolved before or during the runtime skeleton phase.

## License

Recommended default: Apache-2.0.

Alternatives:

- MIT for simplicity
- dual license only if there is a clear commercial strategy

## Implementation Language

Current direction:

- TypeScript for runtime, CLI, schemas, provider adapters, and MCP
- Swift only for the eventual macOS menubar companion

## State Store

Initial implementation:

- local filesystem JSON run records under `.thehood/runs`

Later option:

- SQLite for querying run history and UI state

## First Provider Adapters

Recommended order:

1. Codex CLI adapter
2. Anthropic API adapter
3. OpenAI API adapter
4. ChatGPT Web adapter as experimental
5. Claude Code adapter

## First Runtime Validation Strategy

Start with project-discovered commands:

- package scripts
- language build files
- CI files

Avoid inventing validation commands when a repo already defines them.

## macOS Menubar Timing

Build after the CLI and local runtime can run a complete plan/implement/verify loop.
