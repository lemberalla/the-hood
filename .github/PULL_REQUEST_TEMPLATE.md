## Summary

- Summary of changes.

## Verification

- [ ] `npm test` or the individual checks below
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run smoke:mcp`
- [ ] `npm run smoke:codex-config`
- [ ] `npm run smoke:runtime` or documented why it was skipped
- [ ] `npm pack --dry-run --json` if package contents changed
- [ ] `git --no-pager diff --check`

## Safety

- [ ] No secrets, browser profiles, provider tokens, or private run logs are included
- [ ] No `.thehood/` runtime artifacts are included
- [ ] No package archives are included
- [ ] Provider, approval, filesystem, MCP, or verification behavior changes are explained
- [ ] Test, fixture, snapshot, or eval changes are explicitly called out
- [ ] Public docs remain honest about developer-preview limitations
