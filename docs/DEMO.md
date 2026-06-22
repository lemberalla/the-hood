# Synthetic Stub Demo

This demo proves the public-preview loop without sending code or artifacts to an external provider.

It uses only the deterministic `stub` provider, a temporary demo repository, local runtime state, and a package validation script that prints a fixed message.

## Run The Demo From This Checkout

Build TheHood first:

```bash
npm run build
```

Create a synthetic repository and give it a validation command:

```bash
DEMO_REPO="$(mktemp -d)"
node dist/cli/main.js init --repo "$DEMO_REPO"
node dist/cli/main.js approvals policy set mode autopilot --repo "$DEMO_REPO"
cat > "$DEMO_REPO/package.json" <<'JSON'
{
  "scripts": {
    "typecheck": "node -e \"process.stdout.write('demo validation ok\\n')\""
  }
}
JSON
```

Run a bounded goal loop with stub roles:

```bash
node dist/cli/main.js goal "Synthetic demo: prove a governed local loop can complete" \
  --repo "$DEMO_REPO" \
  --orchestrator stub:orchestrator \
  --implementer stub:implementer \
  --qa stub:qa \
  --verifier stub:verifier \
  --critic stub:critic \
  --max-iterations 5 \
  --json
```

The run should complete locally and emit a JSON result with:

- `run.state` set to `completed`
- `run.mode` set to `implement`
- `run.maxIterations` set to `5`
- provider responses from the deterministic stub provider
- runtime-owned approval events showing autopilot decisions

Inspect the final state:

```bash
node dist/cli/main.js status --repo "$DEMO_REPO"
```

## Boundary

This demo does not use ChatGPT Pro, Claude Code, Codex CLI, OpenAI API, Anthropic API, browser automation, the ChatGPT MCP connector, a hosted queue, a timer, or a cloud service.

It is intentionally synthetic. Its purpose is to show the runtime loop, role separation, approval policy, artifacts, validation evidence, and terminal completion behavior without depending on external accounts or private repository contents.
