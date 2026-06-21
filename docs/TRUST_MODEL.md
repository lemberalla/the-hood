# Trust Model

TheHood's trust model is deliberately simple:

- Models suggest.
- The runtime enforces.
- Users stay in control.

The runtime is the authority for state, permissions, approvals, artifacts, and verification. Provider sessions are disposable.

## Runtime Authority

The runtime owns:

- run state
- role assignments
- approval gates
- provider directives
- provider response validation
- command execution metadata
- git evidence
- isolated patch capture and integration reports
- protected path classification
- final reports and progress packets

Models can summarize or recommend actions, but summaries do not replace runtime evidence.

## Role Separation

The implementer and verifier must not be the same authority for the same task. Verifier, QA tester, critic, and researcher roles are read-only. Same-run summons and fan-outs are advisory sidecar evidence; they do not satisfy required verifier or runtime validation lanes.

## Evidence

Runtime-captured evidence wins over model claims. A completed run should point to exact artifacts such as:

- command logs with cwd, args, duration, and exit code
- git status and diff snapshots
- provider invocation artifacts
- validation command artifacts
- review routing artifacts
- verifier or critic responses
- final reports and progress packets

## External Transfers

Before local repo context, progress packets, or memory bodies cross a browser/API provider boundary, TheHood writes a transfer manifest. The manifest records destination, purpose, source refs, byte counts, risk class, bounded preview, and approval copy.

Refs-only GitHub connector context names remote coordinates instead of local file excerpts and is selected only when the provider connector route is confirmed. It does not replace transfer manifests for local context bodies.

## Fail-Closed Behavior

The runtime should stop instead of guessing when it sees:

- missing approval
- protected test/fixture/snapshot/eval changes
- secret-risk transfers
- unverified provider output
- schema-invalid model responses
- verifier `ask_user` or `abort`
- max iteration exhaustion
- dirty-checkout integration blockers

## Public Repo Boundary

The public repository must not include credentials, browser profiles, provider transcripts, private run logs, local `.thehood` state, environment files, generated package archives, or real private repo data. Examples and demos must be synthetic.
