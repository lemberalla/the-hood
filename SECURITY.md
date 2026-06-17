# Security Policy

TheHood coordinates local tools, provider credentials, browser sessions, source code, and model context. Treat security issues seriously.

## Reporting

Private vulnerability reporting should be enabled before the repository is made public.

Until a private reporting channel is configured, do not publish exploit details in public issues. Share only a minimal, non-sensitive description and request a private contact path.

## Sensitive Areas

Security-sensitive code includes:

- provider authentication
- browser session handling
- secret redaction
- filesystem permissions
- shell command execution
- worktree integration
- MCP tool exposure
- log storage

## Expectations

- Do not log secrets.
- Do not send secrets to model providers by default.
- Do not bypass provider access controls.
- Fail closed when permissions or provider identity are uncertain.
- Require approval for destructive commands and protected file changes.

