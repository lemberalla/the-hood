# Completion Contract

A completion contract is the pre-work definition of done for a TheHood goal loop. It turns "keep working until good" into a bounded, reviewable target.

## Contract Fields

| Field | Meaning |
| --- | --- |
| Goal | The concrete outcome the run should achieve. |
| Acceptance criteria | Conditions that must be true before completion. |
| Allowed paths | Files or directories the implementer may change. |
| Forbidden changes | Changes that must stop the run or require separate approval. |
| Validation | Commands or evidence required before verifier review. |
| Stop condition | When the loop should stop even if the model wants to continue. |
| Iteration budget | Maximum provider/repair attempts before fail-closed behavior. |
| Required evidence | Artifact classes the final report must reference. |

## Example

```yaml
goal: Prepare npm preview package metadata.
allowed_paths:
  - package.json
  - package-lock.json
  - docs/NPM_PUBLISHING.md
forbidden_changes:
  - npm publish
  - npm token or secret files
  - hosted backend code
acceptance_criteria:
  - package version is 0.1.0-preview.0
  - release:check exists and uses existing smoke commands
  - package manifest check succeeds
validation:
  - npm run typecheck
  - npm run build
  - npm run smoke:mcp
  - npm run smoke:codex-config
  - npm run smoke:runtime
  - npm run pack:check
  - git --no-pager diff --check
stop_condition: verifier approves or asks user to resolve a release boundary
iteration_budget: 5
required_evidence:
  - package diff
  - validation command logs
  - final report
```

## Runtime Behavior

The implementer can produce changes, but it cannot accept its own work. Completion requires runtime-captured evidence and independent verifier review when the run is an implementation run.
