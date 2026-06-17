# Provider Adapters

Provider adapters connect role contracts to concrete model or agent systems.

Adapters translate TheHood's structured role requests into provider-specific calls, then normalize the result back into TheHood schemas.

## Adapter Interface

Each adapter should support:

```ts
interface ProviderAdapter {
  id: string;
  runAgent(request: AgentRequest): Promise<AgentResponse>;
}
```

Current request shape:

```yaml
agent_request:
  run: RunRecord
  role: orchestrator | planner | researcher | implementer | verifier | critic
  assignment:
    provider: string
    model: string
  context: object
  directive:
    objective: string
    instructions:
      - string
    tool_permissions:
      read: boolean
      edit: boolean
      shell: boolean
      network: boolean
    output_contract:
      schema_version: 1
      name: string
      required_data_key: string
    variables:
      run: object
      role: object
      context: object
```

The runtime writes each directive as a `directive` artifact before provider execution. It validates each provider response against the role output contract before advancing the run state.

## Local Command Runner

The local command runner is shared by CLI-backed adapters.

Rules:

- It invokes commands without a shell.
- It passes the runtime directive as stdin or prompt input.
- It asks the provider to return the normalized `AgentResponse` JSON envelope.
- It redacts obvious secrets from captured process output before parsing.
- It fails closed with a schema-compatible blocked or failed response when output is unstructured.
- It does not use dangerous bypass flags.

## Stub Adapter

Purpose:

- Exercise the runtime loop without external model calls.
- Produce deterministic orchestrator, implementer, critic, and verifier responses.
- Keep smoke tests stable while the real provider adapters are still being built.

Best roles:

- orchestrator
- implementer
- verifier
- critic

Rules:

- It must not edit files.
- It must use runtime evidence for verifier decisions.
- It exists for testing the orchestration contract, not for real work.

## ChatGPT Web Adapter

Purpose:

- Use the user's authenticated ChatGPT session for models only exposed in ChatGPT.
- Support ChatGPT Pro as an orchestrator or planner.

Rules:

- Use the user's existing subscription and browser session.
- Do not bypass access controls.
- Do not extract cookies or tokens into logs.
- Do not rely on hidden chain-of-thought.
- Prefer structured visible outputs.
- Fail closed when the requested model cannot be confirmed.

Best roles:

- orchestrator
- planner
- critic

Risk:

- Browser UI changes can break automation.
- Output extraction can be brittle.
- Terms and product behavior may change.

## OpenAI API Adapter

Purpose:

- Use API-accessible GPT models for structured workers.

Best roles:

- implementer
- planner
- researcher
- verifier
- critic

Notes:

- Prefer structured output features when available.
- Keep raw provider responses out of public logs if they contain sensitive context.

## Anthropic API Adapter

Purpose:

- Use Claude models as guest agents or primary role owners.

Best roles:

- critic
- verifier
- architect/planner
- implementer when tool integration is available

Notes:

- Claude can be especially useful as an independent reviewer because it brings a different model family into the loop.
- It still must obey the same runtime permissions.

## Codex CLI Adapter

Purpose:

- Use Codex as an implementation or investigation worker.

Best roles:

- implementer
- researcher
- reviewer

Rules:

- Scope tasks tightly.
- Capture diffs and logs.
- Do not let Codex self-verify its own changes.
- Run through `codex exec` with TheHood's role directive.
- Use `read-only` sandbox for non-editing roles and `workspace-write` for editing roles.
- Do not pass dangerous sandbox bypass flags.

## Claude Code Adapter

Purpose:

- Use Claude Code as a guest implementation or review worker.

Best roles:

- implementer
- critic
- verifier

Rules:

- Same separation rules as any other implementer.
- If Claude Code edits, another agent verifies.
- Run through `claude --print` with TheHood's role directive.
- Use plan/read tools for non-editing roles.
- Do not pass permission bypass flags.

## Local Model Adapter

Purpose:

- Support private or cheap local workers.

Best roles:

- formatting
- simple refactors
- search summarization
- low-risk repetitive work

Rules:

- Keep tasks narrow.
- Do not use local model output as authoritative verification unless backed by deterministic logs.
