# Public Repo Readiness

This checklist tracks the public preview posture for TheHood. `v0.1.0-preview.0` is published as an npm developer preview, so this file now tracks the baseline that should remain true for the public repo plus the gates for the next preview or stable release.

## Release Position

The public preview should make one claim clearly: TheHood is a local runtime for governed software goal loops. It can plan, act, capture evidence, verify independently, revise, stop safely, and preserve artifacts.

It should not claim cloud routines, hosted execution, API-provider automation, a full dashboard, or polished native app rendering.

## Public Preview Baseline

- Keep the root MIT `LICENSE` and `package.json` license metadata in sync.
- Keep `CONTRIBUTING.md`, `SECURITY.md`, `PRIVACY.md`, and `CODE_OF_CONDUCT.md` present in the repository and package boundary.
- Keep private vulnerability reporting enabled for `lemberalla/the-hood`.
- Keep `.thehood/`, browser profile state, provider logs, local env files, package archives, and generated build output out of git.
- Keep examples and fixtures synthetic. Do not publish real runtime artifacts or provider transcripts.
- Verify a fresh clone path: `npm ci`, `npm run build`, `npm run smoke:mcp`, `npm run smoke:codex-config`, and `npm run smoke:runtime`.
- Verify release packaging with `npm run release:check`.
- Verify package contents with `npm run pack:check`.
- Keep the synthetic stub demo runnable from `examples/stub-demo` and `docs/DEMO.md`.
- Keep the static site in `site/` dependency-free, analytics-free, and aligned with README claims.
- Make README claims match current behavior. Mark API adapters, hosted UI, and automatic Codex app rendering beyond explicit agent board artifact payloads as planned unless implemented.
- Keep ChatGPT MCP connector mode documented as experimental and optional. It depends on external ChatGPT custom connector availability and is not a public-preview blocker.
- Keep branch protection, required CI checks, secret scanning or push protection, private vulnerability reporting, Dependabot security updates, issue templates, PR template, CODEOWNERS, stale-review dismissal, and conversation-resolution requirements enabled on GitHub.
- Treat advanced GitHub secret scanning toggles for non-provider patterns and validity checks as optional hardening. They were unavailable or remained disabled after the initial public-preview setup attempt and should be revisited when the repository plan or GitHub feature availability supports them.

## Current Public Surface

- Runtime roles, same-run summons, bounded fan-out, review lanes, crew lanes, and run artifacts are implemented as local runtime concepts.
- Codex CLI and Claude Code adapters are implemented through local command providers.
- ChatGPT Pro works through the user-authenticated ChatGPT Web bridge when configured by the user.
- OpenAI and Anthropic API provider config exists, but external API adapters are not implemented yet.
- Agents are visible through CLI, MCP, TUI, status, logs, artifact surfaces, structured agent board snapshots, and renderable dashboard payloads. The optional Codex plugin provides TheHood workflow guidance and MCP wiring, but automatic native Codex app rendering on every TheHood run is still a later integration layer.

## Package Boundary

`package.json` uses a `files` allowlist. `npm run pack:check` should include built `dist/`, README, package metadata, docs, and the synthetic demo only. It should not include `.thehood/`, `src/`, `node_modules/`, `.env`, browser state, provider logs, local config, site drafts, GitHub workflow internals, or generated archives.

## Release Gate

Before the next preview release, run:

```bash
npm ci
npm run release:check
npm run pack:check
git --no-pager diff --check
```

After publishing, verify the package from outside the repo:

```bash
tmpdir=$(mktemp -d /private/tmp/thehood-install-smoke-XXXXXX)
cd "$tmpdir"
npm init -y
npm install thehood@next
./node_modules/.bin/thehood --help
./node_modules/.bin/thehood doctor --repo /path/to/the-hood
```

Future publishing should happen through npm Trusted Publishing from the tag-triggered workflow. Do not add npm tokens to the repo. Public docs should prefer `thehood@next`; because `v0.1.0-preview.0` is the first npm publish, npm `latest` may also resolve to the preview package until a stable line exists.
