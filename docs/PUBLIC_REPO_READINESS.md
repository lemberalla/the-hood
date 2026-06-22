# Public Repo Readiness

This checklist tracks repo-side scaffolding and external GitHub settings required before a public `v0.1.0-preview.0` developer-preview launch. The repo can be built and smoked locally today, but public release still requires a final safety, packaging, and repository-settings pass.

## Release Position

The public preview should make one claim clearly: TheHood is a local runtime for governed software goal loops. It can plan, act, capture evidence, verify independently, revise, stop safely, and preserve artifacts.

It should not claim cloud routines, hosted execution, API-provider automation, a full dashboard, or polished native app rendering.

## Must Finish Before Public

- Keep the root MIT `LICENSE` and `package.json` license metadata in sync.
- Keep `CONTRIBUTING.md`, `SECURITY.md`, `PRIVACY.md`, and `CODE_OF_CONDUCT.md` present in the repository and package boundary.
- Confirm private vulnerability reporting is enabled for `lemberalla/the-hood`.
- Keep `.thehood/`, browser profile state, provider logs, local env files, package archives, and generated build output out of git.
- Keep examples and fixtures synthetic. Do not publish real runtime artifacts or provider transcripts.
- Verify a fresh clone path: `npm ci`, `npm run build`, `npm run smoke:mcp`, `npm run smoke:codex-config`, and `npm run smoke:runtime`.
- Verify release packaging with `npm run release:check`.
- Verify package contents with `npm run pack:check`.
- Keep the synthetic stub demo runnable from `examples/stub-demo` and `docs/DEMO.md`.
- Keep the static site in `site/` dependency-free, analytics-free, and aligned with README claims.
- Make README claims match current behavior. Mark API adapters, hosted UI, and automatic Codex app rendering beyond explicit agent board artifact payloads as planned unless implemented.
- Keep ChatGPT MCP connector mode documented as experimental and optional. It depends on external ChatGPT custom connector availability and is not a public-preview blocker.
- Configure branch protection, required CI checks, secret scanning or push protection, private vulnerability reporting, and issue/PR templates on GitHub. These settings are external to the repository tree and must be verified before public launch.

## Current Public Surface

- Runtime roles, same-run summons, bounded fan-out, review lanes, crew lanes, and run artifacts are implemented as local runtime concepts.
- Codex CLI and Claude Code adapters are implemented through local command providers.
- ChatGPT Pro works through the user-authenticated ChatGPT Web bridge when configured by the user.
- OpenAI and Anthropic API provider config exists, but external API adapters are not implemented yet.
- Agents are visible through CLI, MCP, TUI, status, logs, artifact surfaces, structured agent board snapshots, and renderable dashboard payloads. The optional Codex plugin provides TheHood workflow guidance and MCP wiring, but automatic native Codex app rendering on every TheHood run is still a later integration layer.

## Package Boundary

`package.json` uses a `files` allowlist. `npm run pack:check` should include built `dist/`, README, package metadata, docs, and the synthetic demo only. It should not include `.thehood/`, `src/`, `node_modules/`, `.env`, browser state, provider logs, local config, site drafts, GitHub workflow internals, or generated archives.

## Release Gate

Before the first public release, run:

```bash
npm ci
npm run release:check
git --no-pager diff --check
```

Publishing must happen through npm Trusted Publishing from the tag-triggered workflow. Do not publish locally and do not add npm tokens to the repo.
