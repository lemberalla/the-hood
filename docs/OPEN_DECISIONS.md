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

## Memory Store

Current direction:

- exact run records and artifacts are canonical
- summaries, embeddings, graphs, and provider reflections are derived memory
- derived memory must preserve source refs and be rebuildable

Open options:

- SQLite plus full-text search for the first local index
- vector index for semantic retrieval
- graph index for ontology relationships
- external or embedded memory engines after canonical artifacts and reconciliation are stable

## Planner Reconciliation

Current direction:

- after implementation and verification, TheHood can send an approved progress packet back to the original planner or orchestrator
- the provider returns a schema-bound reconciliation result
- runtime stores the result as an artifact and uses it to inform the next slice

Open question:

- should reconciliation attach to the original plan run, create a child run, or both?

## Remaining Provider Adapters

Current status:

1. Codex CLI adapter is implemented through the local command runner.
2. Claude Code adapter is implemented through the local command runner.
3. ChatGPT Web adapter is implemented as an experimental user-authenticated bridge.
4. OpenAI API adapter remains future work.
5. Anthropic API adapter remains future work.
6. Local model adapter remains future work.

## First Runtime Validation Strategy

Start with project-discovered commands:

- package scripts
- language build files
- CI files

Avoid inventing validation commands when a repo already defines them.

## macOS Menubar Timing

Build after the CLI and local runtime can run a complete plan/implement/verify loop.
