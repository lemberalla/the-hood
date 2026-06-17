# 0001: Runtime First With CLI And MCP

## Status

Accepted

## Context

TheHood needs to run agent loops from Codex and eventually a macOS menubar app. The orchestration logic must not live in a frontend or a single chat session.

## Decision

Build a local runtime first. Expose it through a CLI and MCP server before building a macOS UI.

The CLI is the complete control plane. The MCP server lets Codex trigger runtime actions. The menubar app can later provide status, approvals, and quick triggers over the same runtime.

## Consequences

- The system can run headless.
- Codex integration does not own orchestration safety.
- The menubar app remains thin.
- Runtime behavior is easier to test and audit.

