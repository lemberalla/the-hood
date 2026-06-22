# Stub Demo

This example is the public-preview demo path for TheHood.

It runs a bounded goal loop against a temporary synthetic repository using only the deterministic `stub` provider. It does not call external models, browser providers, API providers, or connector tools.

From the repository root:

```bash
npm run build
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
node dist/cli/main.js goal "Synthetic demo: prove a governed local loop can complete" --repo "$DEMO_REPO" --orchestrator stub:orchestrator --implementer stub:implementer --qa stub:qa --verifier stub:verifier --critic stub:critic --max-iterations 5 --json
node dist/cli/main.js status --repo "$DEMO_REPO"
```

See [docs/DEMO.md](../../docs/DEMO.md) for the demo boundary and expected evidence.
