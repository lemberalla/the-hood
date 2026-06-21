# Goal, Loop, Schedule

TheHood `v0.1.0-preview.0` is about governed software goals and bounded local loops. It is not yet a scheduling product.

## Goal

A goal is a concrete software objective with a verifiable stop condition.

Examples:

- "Prepare npm preview release metadata and prove package dry-run succeeds."
- "Add a synthetic stub demo and verify it does not call external providers."
- "Fix a failing smoke test and capture validation evidence."

A good goal includes:

- acceptance criteria
- allowed paths
- forbidden changes
- validation commands
- iteration budget
- stop condition

## Loop

A loop is a runtime-owned sequence that keeps advancing a run until a terminal state, manual gate, no progress, or a budget cap.

Loops can plan, delegate, capture evidence, verify, revise, and stop. They are local-session workflows. If the local process stops, the run record remains, but TheHood is not a hosted daemon.

## Schedule

A schedule is a future routine that runs later or repeatedly from a daemon or hosted service.

Schedules are not part of `v0.1.0-preview.0`. The preview should not claim cloud routines, timer loops, overnight PR repair, or post-commit automation as current behavior.

## Product Boundary

For the preview:

- `goal` is in scope.
- `loop` is in scope while the local runtime is active.
- `schedule` is future work.

The CLI goal surface is intentionally thin:

```bash
thehood goal "Prepare release metadata" --repo . --max-iterations 5
```

It creates a normal implementation run and drives the existing headless loop. It does not add timers, background daemons, cloud queues, or new approval semantics.
