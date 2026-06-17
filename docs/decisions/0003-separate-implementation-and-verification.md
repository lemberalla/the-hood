# 0003: Separate Implementation And Verification

## Status

Accepted

## Context

An agent that implements a change has an incentive to justify its own work. It may overlook failures or modify tests to make the result pass.

## Decision

The implementer and verifier must not be the same agent for the same task.

Implementers may run tests for feedback, but the authoritative verification phase belongs to the runtime and a separate verifier.

The verifier has no edit tools.

Changes to tests, fixtures, snapshots, or evaluation files are protected and require explicit classification and approval.

## Consequences

- The system does not let an implementer grade its own work.
- Test changes become visible and reviewable.
- Runtime-captured logs become the evidence base.
- Verification can be assigned to a different model family for stronger review.

