# Loop Selection UX

Users should not need to know recipe IDs before asking TheHood for a loop. The product should accept an outcome, recommend a loop shape, draft a completion contract, and make the next action explicit.

## Codex App Flow

When a user says something like:

```text
Use Hood loops to fix flaky checkout tests.
```

Codex should call `thehood_recommend_loop` first. The tool is read-only. It does not call model providers, start a run, edit files, create schedules, or send external context.

The response contains:

- recommended recipe
- confidence
- plain-English reason
- recommended stack
- completion contract draft
- alternatives
- `runAction` for the existing runtime tool
- card actions
- renderer-facing `card`
- dashboard-shaped `artifact` for a Codex card

Codex should render `card` directly when present. `artifact.manifest` and `artifact.snapshot` are the dashboard/table fallback for hosts that do not understand the card shape.

The card should read like this:

```text
Recommended loop: Build, Test, Fix
Why: scoped code task with validation and likely repair cycles.

Stack:
- Build, Test, Fix
- Verifier Loop

Completion contract:
- Goal
- Evidence
- Validation
- Stop conditions
- Iteration budget

Actions:
- Run loop
- Edit contract
- Show alternatives
```

The "Run loop" action should invoke the existing runtime path from `runAction`, usually `thehood_orchestrate` with `auto_loop: true`. Runtime approvals, provider calls, edit gates, evidence capture, verifier review, and stop conditions still happen inside TheHood. The card is guidance, not authority.

The "Edit contract" action should keep the user inside the recommendation step. The edited acceptance criteria, validation commands, allowed paths, forbidden changes, and iteration budget are passed back into `thehood_recommend_loop`; Codex should not mutate orchestration state or start a provider call while the user is still editing the contract.

## Codex MCP Refresh

After local development changes, a fresh MCP server launch should expose `thehood_recommend_loop`. Existing Codex threads may keep the tool schema they already loaded, so a thread can still look stale even after `npm run build` succeeds.

Validate the fresh server path with:

```bash
npm run build
npm run smoke:codex-config
```

If the smoke passes but the current Codex conversation still lacks `thehood_recommend_loop`, start a new Codex thread or reload the app/session so Codex reconnects to the MCP server.

## Terminal Flow

The equivalent terminal inspection command is:

```bash
thehood recommend-loop "fix flaky checkout tests" --repo . --max-iterations 5
```

This prints the same recommendation, stack, contract draft, and actions. Contract edits can be supplied before the run starts:

```bash
thehood recommend-loop "prepare hood for public release" \
  --repo . \
  --acceptance "README claims match implemented behavior" \
  --validation "npm run smoke:mcp" \
  --allowed-path README.md \
  --forbidden-change "Do not publish private run logs" \
  --max-iterations 8
```

Users can still run the normal goal command:

```bash
thehood goal "fix flaky checkout tests" --repo . --max-iterations 5
```

## Selection Rules

The router uses the user's goal and constraints to choose among the public recipes:

- `build-test-fix`: scoped implementation with validation and repair.
- `verifier-loop`: correctness-sensitive work where independent proof matters.
- `anti-spin`: ambiguous or repeated-failure work that needs hard stops.
- `completion-contract`: release, package, public, or high-trust work where "done" must be explicit.
- `quality-streak`: flaky or stability-sensitive work that should require repeated clean validation. This is planned as execution behavior and should be labeled accordingly.
- `adversarial-review`: risky architecture, product, security, UX, or strategy work that needs critique.
- `human-approval-queue`: work expected to pause at explicit approval gates.

If confidence is high, show the single recommended loop plus alternatives. If confidence is medium or low, show the top choices and ask one plain-language question only when the missing answer changes safety or proof.

## Boundaries

- Recommendation is read-only.
- Recipe names are product vocabulary, not new permissions.
- Recommendation does not schedule work.
- Recommendation does not approve provider calls.
- Recommendation does not replace completion evidence.
- Sidecar critique remains advisory.
- Runtime validation plus verifier review still decide completion for implementation runs.
