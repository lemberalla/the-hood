# Security And Privacy

TheHood coordinates powerful local actions. Security and privacy must be designed into the runtime from the start.

## Principles

- User credentials stay local.
- Provider sessions are never logged.
- Runtime permissions are explicit.
- Models do not receive secrets by default.
- Dangerous actions require approval.
- Logs are useful but redacted.
- The system fails closed when unsure.

## Secrets

Secrets include:

- API keys
- browser cookies
- session tokens
- OAuth credentials
- SSH keys
- private repo URLs when sensitive
- payment or customer data
- private prompts containing confidential data

Rules:

- Do not print secrets to logs.
- Do not include secrets in model context.
- Redact environment variables by default.
- Store provider credentials using OS keychain or provider CLI config when possible.
- Require explicit user approval before invoking model-backed providers for read-only repo work.
- Require explicit user approval before sending runtime-captured repo context to browser or API model providers.
- Require explicit user approval before sending runtime-captured progress, memory, or reconciliation packets to browser or API model providers.

## Browser-Based Providers

The ChatGPT Web adapter is sensitive because it depends on a user-authenticated browser session.

Rules:

- Use an isolated browser profile when possible.
- Prefer the TheHood-managed persistent Chrome profile over the user's main Chrome profile.
- Do not export cookies.
- Do not write session tokens to disk.
- Do not bypass provider restrictions.
- Detect model availability visibly and fail if uncertain.
- Capture only visible model outputs needed for the run.
- Do not invoke ChatGPT Web for repo work until the user explicitly approves that provider invocation.
- Do not send bounded repo context back to ChatGPT Web until the user explicitly approves that external context transfer.

## Filesystem Safety

The runtime must:

- inspect dirty state before edits
- avoid reverting unrelated user changes
- isolate worker changes in worktrees when possible
- enforce allowed and disallowed paths
- block protected test changes unless approved
- run edit-capable local agents in isolated git worktrees by default and capture patch artifacts for review
- require explicit approval before applying isolated worker patches to the target checkout
- require separate approval before verifier review when an applied worker patch changes protected test, fixture, snapshot, or eval paths
- require `THEHOOD_ALLOW_DIRECT_EDIT=1` before a local agent can edit the target checkout directly

## MCP Repo Gateway

MCP repo gateway tools are read-only, bounded, and skip `.git`, `.thehood`, dependency/build output, and secret-looking paths.

Rules:

- Treat every repo gateway tool result as data disclosed to the connected MCP host.
- Use trusted MCP hosts only, especially when connecting ChatGPT Developer Mode to private local repos.
- Prefer Secure MCP Tunnel over public tunnels for private repos.
- Keep write tools separate from read tools and gated by runtime approval.
- Do not expose broad filesystem access; every path must stay relative to the configured repo root.

## Command Safety

Commands should be classified before execution:

- read-only
- local write
- network
- dependency install
- destructive
- credential-sensitive

Approval is required for commands with risky side effects.

## Logging

Logs should include:

- command
- cwd
- duration
- exit code
- redacted stdout
- redacted stderr
- permission decision

Logs should not include:

- raw cookies
- API keys
- hidden browser state
- full secret-bearing environment

## Memory Safety

Memory is a control channel. Retrieved memories, reflections, and summaries can influence model decisions, so they must be treated as derived data rather than authority.

Rules:

- Preserve exact source artifacts before creating derived memories.
- Keep provenance for every derived memory: source refs, run id, created timestamp, commit or repo state when applicable, and derivation method.
- Prefer exact excerpts and artifact refs over summary-only memory packets.
- Mark superseded or invalidated plan state instead of silently overwriting it.
- Tell browser-backed providers to ignore stale provider session context and use only TheHood-supplied state.
- Keep advanced memory engines pluggable and rebuildable from canonical artifacts.

## Public Repo Boundary

The public repo should not contain:

- real provider credentials
- personal browser profiles
- private prompts
- run logs from private repos
- hardcoded local paths as defaults

Fixtures should be synthetic.
