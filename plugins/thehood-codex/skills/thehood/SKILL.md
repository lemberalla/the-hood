---
name: thehood
description: Use when the user wants Codex to run work through TheHood, inspect TheHood runtime state, use the TheHood agent board, configure TheHood MCP, coordinate Pro/Codex/Claude roles, or install the TheHood runtime.
---

# TheHood

TheHood is a local runtime. Models and Codex plugin skills may suggest work, but TheHood owns run state, permissions, approvals, artifacts, verifier separation, and role policy.

## First Checks

1. Prefer TheHood MCP tools when they are available.
2. Start with `thehood_doctor` for the target repo before running provider or implementation work.
3. Use `thehood_pro_access` before direct ChatGPT Pro consults from Codex, or immediately after a host-policy rejection.
4. If MCP tools are unavailable, check whether the runtime CLI is installed with `thehood --version`.
5. If the runtime is missing, ask before installing or building it.

## Runtime Use

- Use `thehood_agent_board` when the user asks to see agents, lanes, role ownership, or current runtime status. Set `include_artifact: true` when the user wants a renderable dashboard payload.
- Use `thehood_pro_access` when the user asks for Pro from Codex. This is local-only and does not call Pro; it reports runtime policy, bridge readiness, and connector-mode handoff instructions.
- Use `thehood_consult`, `thehood_summon`, or `thehood_fanout` for read-only guest roles.
- Use `thehood_orchestrate` for implementation work and `thehood_continue` to resume active runs.
- Pass `approval: "none"` to `thehood_continue` when no manual approval gate is active. The runtime may auto-approve bounded low-risk gates when policy allows and will record that evidence.
- Use explicit approval only for an active manual gate after the user approves that gate.

## Boundaries

- Do not treat this skill, a plugin card, a dashboard artifact, or a Codex-native subagent as runtime authority.
- Do not let the same role satisfy implementer and verifier duties for the same task.
- Do not give verifier or critic roles edit tools.
- Do not treat an agent board card as proof that validation, review, or approval passed. Read the referenced artifacts, events, handoffs, and command evidence.
- Do not send secrets, browser profiles, provider tokens, private run logs, or unrelated repo content outside the local runtime.
- If Codex rejects a direct `chatgpt-web` call as an external disclosure, do not ask for the same approval again and do not try to route around the host policy. Call `thehood_pro_access` and use ChatGPT MCP connector mode or an abstract no-repo-context prompt.

## Installation Guidance

For a published runtime, prefer the package manager command documented by the repository. For a local checkout, build and configure the runtime from the repo:

```bash
npm install
npm run build
node dist/cli/main.js setup --repo .
```

The plugin's MCP server config expects `thehood mcp` to be on `PATH`. During local development, users can either install/link the package or use the explicit MCP snippet from:

```bash
node dist/cli/main.js mcp config
```
