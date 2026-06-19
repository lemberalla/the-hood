# Memory And Reconciliation

TheHood should make model chat context disposable. A provider window or API conversation can help with reasoning, but it must not be the durable memory for a project.

## Core Principle

```text
TheHood remembers.
Models are rehydrated from TheHood state.
```

The runtime preserves exact state first, then builds bounded context packets from that state when a model needs to reason.

Summaries can be useful as previews, labels, or navigation aids. They are not canonical memory and must not replace source artifacts.

## Memory Layers

### Canonical Memory

Canonical memory is the source of truth. It must be inspectable, durable, and grounded in exact artifacts.

Examples:

- run records
- event logs
- approval events
- provider directives
- provider responses
- plans
- diffs and commits
- command logs
- validation results
- verifier verdicts
- final reports
- reconciliation outputs

Canonical memory should be local-first and append-oriented. Existing filesystem run records and artifacts are the first implementation. A later SQLite store can index these records, but it should not replace the artifacts as the source of truth.

### Index Memory

Index memory exists to make canonical memory searchable and queryable.

Examples:

- SQLite tables
- full-text search
- embeddings
- graph indexes
- typed plan and task indexes

Index memory can be rebuilt from canonical memory. If an index disagrees with a source artifact, the artifact wins.

### Derived Memory

Derived memory helps models retrieve relevant context efficiently.

Examples:

- retrieved excerpts
- model-generated reflections
- planner reconciliations
- temporal graphs
- vector memories
- external memory engines such as Mem0, Zep, Letta, MemVid-style systems, or future adapters

Derived memory must keep provenance:

- source artifact refs
- run id
- created timestamp
- commit or repo state when applicable
- derivation method
- supersedes or invalidates relationships when applicable

Derived memory can accelerate reasoning, but it is not an authority boundary.

## Ontology

The runtime should preserve a stable project ontology so different models can share the same concepts even when provider sessions are reset.

Initial entities:

- `Run`
- `Plan`
- `Slice`
- `Task`
- `Agent`
- `Role`
- `Artifact`
- `Evidence`
- `Approval`
- `Commit`
- `Validation`
- `VerifierVerdict`
- `Reconciliation`
- `Decision`

Initial relationships:

- `plan_created_by`
- `task_implements_plan_item`
- `artifact_derived_from`
- `commit_satisfies_criteria`
- `validation_checks_commit`
- `verifier_reviews_evidence`
- `reconciliation_supersedes_plan_state`
- `decision_selects_next_slice`

These names should be versioned with the runtime schema. Provider prompts should use these terms instead of inventing new labels per provider.

## Rehydration Packets

Before invoking an orchestrator, planner, verifier, critic, or memory-aware provider, TheHood should build a bounded context packet from canonical state.

The packet should include exact refs and selected exact excerpts where possible:

- current run id and parent or related run ids
- repo path and current git HEAD
- dirty state
- original user goal
- latest accepted plan state
- selected plan items and acceptance criteria
- relevant artifacts and refs
- changed files and commits
- command and validation evidence
- verifier verdicts
- open risks and unresolved questions

The packet may include compact descriptions for navigation, but every important claim should point back to an artifact, command log, commit, or event.

Provider directives should tell the model to ignore stale browser or conversation memory and reason only from TheHood-provided state.

Current provider directives include a compact `canonicalMemory` object. This is not a memory engine. It is a bounded runtime-owned index with the current run snapshot, recent run summaries, and latest artifact refs for progress packets, reconciliation, repo context, final reports, and transfer manifests. It intentionally excludes large artifact bodies so browser/API providers can be rehydrated without making ChatGPT conversation history the source of truth.

## Repo Context Retrieval

Repo context retrieval should behave like an evidence-led repository inspection, not a one-shot dump.

The default pattern is:

```text
repo map
targeted reads
follow-up evidence
verification
```

The runtime should include a bounded tree, then prioritize files explicitly named by the user goal, provider decision, or source-of-truth instructions. Explicitly requested files may receive a larger per-file budget than generic files, but they still count against the total packet budget and must retain truncation metadata.

Generic high-priority files such as `README.md`, `AGENTS.md`, architecture docs, runtime contracts, and key runtime modules should fill the remaining budget after requested files.

Huge files should not silently consume the packet. When a source file is too large to include fully, the runtime preserves refs and excerpts, then allows a follow-up targeted context capture when the provider delegates concrete repo paths that were not already captured. Broad or duplicate follow-up delegations still stop rather than pretending the model has complete evidence.

## Planner Reconciliation

Planner reconciliation is the missing loop after implementation.

```text
planner creates plan
runtime stores plan
implementer builds selected slice
runtime captures evidence
verifier reviews evidence
runtime sends approved progress packet back to planner
planner reconciles plan against evidence
runtime stores reconciliation
```

The planner should answer:

- which plan items are complete
- which acceptance criteria are satisfied
- which items remain open
- whether implementation deviated from the plan
- whether the next slice should change
- whether user input is needed

Reconciliation is advisory. The runtime remains responsible for approvals, tool execution, artifact storage, verification gates, and final state.

The current runtime stores `progress` artifacts for completed runs and can reconcile them through the configured planner or orchestrator with `thehood reconcile` or `thehood_reconcile`. Browser and API providers require explicit approval before the progress packet is sent, and successful provider responses are stored as `reconciliation` artifacts. Future planning and reconciliation directives receive latest reconciliation refs through `canonicalMemory` when available.

## Risks

### Lossy Memory

Risk: a summary omits critical details and a model reasons from an incomplete state.

Guardrail: source artifacts remain canonical. Context packets include exact refs and excerpts instead of summary-only memory.

### Stale Memory

Risk: a model reconciles against an old plan, old commit, or old run state.

Guardrail: packets include run ids, timestamps, git HEAD, dirty state, and supersession links.

### Retrieval Poisoning

Risk: a semantically related memory is contextually wrong, unsafe, or obsolete.

Guardrail: retrieved memories must include provenance, source type, and validity metadata. High-impact actions still require runtime gates.

### Provider Session Contamination

Risk: old browser context influences a new answer.

Guardrail: directives instruct browser-backed providers to ignore prior conversation and use only TheHood canonical state. ChatGPT Web bridge responses must echo the current directive acknowledgement before the runtime accepts schema-valid JSON.

### Schema Drift

Risk: provider outputs slowly change shape.

Guardrail: all provider responses remain schema-bound and fail closed when invalid.

## Build Direction

The first implementation should avoid a large memory engine. Build the exact loop first:

1. Add a progress packet builder from canonical run artifacts.
2. Add planner reconciliation as a schema-bound provider call.
3. Store reconciliation artifacts and expose them through CLI and MCP status.
4. Add SQLite or another local index only after the artifact contract is stable.
5. Make advanced memory engines pluggable after canonical and index layers are proven.
