# Glossary

## Agent

A model-backed or tool-backed participant with a role contract, input schema, permissions, and output schema.

## Orchestrator

The role that plans, delegates, compares evidence, and controls the loop.

## Implementer

The role that makes scoped code changes.

## Verifier

The role that evaluates changes using runtime-captured evidence. It has no edit tools.

## Critic

The role that challenges a plan or patch and identifies risk.

## Runtime

The local deterministic system that owns state, permissions, command execution, logs, worktrees, approvals, and integration.

## Provider Adapter

An integration layer that lets TheHood use a model or agent system through a common interface.

## MCP Server

The server that exposes TheHood runtime tools to Codex and other MCP clients.

## Control Surface

A user-facing way to trigger or inspect runtime actions. The CLI, MCP server, and macOS app are control surfaces.

## Protected Path

A file path that requires special approval before modification, such as tests, fixtures, snapshots, or evaluation files.

## Evidence

Runtime-captured material used for decisions, such as diffs, logs, exit codes, and file reads.

