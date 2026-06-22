# Security Policy

TheHood coordinates local tools, provider credentials, browser sessions, source code, and model context. Treat security issues seriously.

## Reporting

Private vulnerability reporting is enabled for the public repository.

Use GitHub private vulnerability reporting for security-sensitive issues. Do not publish exploit details, secrets, provider transcripts, browser state, private run artifacts, or reproduction steps that expose private data in public issues. Public issues should include only a minimal, non-sensitive description.

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
