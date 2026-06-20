## Summary

- Summary of changes.

## Verification

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run smoke:mcp`
- [ ] `npm run smoke:codex-config`
- [ ] `npm run smoke:runtime` or documented why it was skipped

## Safety

- [ ] No secrets, browser profiles, provider tokens, or private run logs are included
- [ ] No `.thehood/` runtime artifacts are included
- [ ] Provider, approval, filesystem, MCP, or verification behavior changes are explained
- [ ] Test, fixture, snapshot, or eval changes are explicitly called out
