# Research Notes

These notes capture the agent-loop patterns TheHood is built from.

## Primary Sources

- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)
- [Anthropic: How We Built Our Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Claude Code: Subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code: Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code: Dynamic Workflows](https://code.claude.com/docs/en/workflows)
- [OpenAI: A Practical Guide To Building Agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
- [Google ADK: Agents](https://adk.dev/agents/)
- [Google ADK: Evaluate](https://adk.dev/evaluate/)
- [Microsoft AutoGen: Teams](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html)
- [LangChain: Plan-And-Execute Agents](https://www.langchain.com/blog/planning-agents)

## Extracted Patterns

### Prompt Chaining

Break work into sequential stages. Each stage produces structured output for the next stage.

TheHood use:

- inspect
- plan
- implement
- verify
- critique
- integrate

### Routing

Route tasks to the right role, model, and permission set.

TheHood use:

- user-configurable role mapping
- provider-neutral adapter layer
- risk-based role selection

### Parallelization

Run independent subtasks in parallel where safe.

TheHood use:

- parallel researchers
- parallel critics
- parallel exploration workers

Implementation changes should be serialized or isolated in separate worktrees.

### Orchestrator-Workers

A high-capability manager delegates scoped tasks to workers.

TheHood use:

- ChatGPT Pro, Claude Opus, or another selected model can orchestrate
- workers receive narrow objectives and permissions
- runtime stores and validates their outputs

### Evaluator-Optimizer

One agent proposes or changes output, another evaluates it, then the loop revises.

TheHood use:

- implementer changes code
- runtime captures diff and logs
- verifier reviews independently
- orchestrator decides next step

### Deterministic Runtime

The runtime is responsible for state, tool execution, and evidence capture.

TheHood use:

- runtime executes commands
- runtime captures logs
- runtime enforces permissions
- models do not self-authorize

## Key Design Conclusion

A model can be intelligent without being trusted as an authority over its own work.

TheHood should use models for reasoning, critique, and generation. It should use local runtime code for permissions, state, evidence, and integration.

