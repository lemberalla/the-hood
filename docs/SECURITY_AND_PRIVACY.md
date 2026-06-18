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

## Browser-Based Providers

The ChatGPT Web adapter is sensitive because it depends on a user-authenticated browser session.

Rules:

- Use an isolated browser profile when possible.
- Do not export cookies.
- Do not write session tokens to disk.
- Do not bypass provider restrictions.
- Detect model availability visibly and fail if uncertain.
- Capture only visible model outputs needed for the run.

## Filesystem Safety

The runtime must:

- inspect dirty state before edits
- avoid reverting unrelated user changes
- isolate worker changes in worktrees when possible
- enforce allowed and disallowed paths
- block protected test changes unless approved
- run edit-capable local agents in isolated git worktrees by default and capture patch artifacts for review
- require `THEHOOD_ALLOW_DIRECT_EDIT=1` before a local agent can edit the target checkout directly

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

## Public Repo Boundary

The public repo should not contain:

- real provider credentials
- personal browser profiles
- private prompts
- run logs from private repos
- hardcoded local paths as defaults

Fixtures should be synthetic.
