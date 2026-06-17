# Provider Adapters

Provider adapters connect role contracts to concrete model or agent systems.

Adapters translate TheHood's structured role requests into provider-specific calls, then normalize the result back into TheHood schemas.

## Adapter Interface

Each adapter should support:

```ts
interface ProviderAdapter {
  id: string;
  listModels(): Promise<ModelDescriptor[]>;
  run(request: AgentRequest): Promise<AgentResponse>;
  healthCheck(): Promise<ProviderHealth>;
}
```

Conceptual request shape:

```yaml
agent_request:
  run_id: string
  role: orchestrator | planner | researcher | implementer | verifier | critic
  model: string
  instructions: string
  input:
    goal: string
    context_refs:
      - string
    artifacts:
      - string
  tool_permissions:
    read: boolean
    edit: boolean
    shell: boolean
    network: boolean
  output_schema: string
```

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

