# NPM Publishing

TheHood `v0.1.0-preview.0` should be published as a preview package only after the public repo, CI, and package boundary are reviewed.

Do not publish from a local machine for the public preview. Do not add npm tokens to the repository or GitHub Actions secrets. Use npm Trusted Publishing / OIDC for the tag-based workflow.

## Before Publishing

1. Verify the npm package name is available or owned by the project maintainer.
2. Configure npm Trusted Publisher for the GitHub repository `lemberalla/the-hood`.
3. Confirm `.github/workflows/publish.yml` is the trusted workflow.
4. Confirm the workflow has `id-token: write` and does not use an npm token.
5. Run the release gate from a clean checkout:

```bash
npm ci
npm run release:check
```

`npm run pack:check` uses a temporary npm cache by default so local cache ownership problems do not block package-boundary verification. If a specific cache path is required, set `THEHOOD_NPM_PACK_CACHE`:

```bash
THEHOOD_NPM_PACK_CACHE=/private/tmp/thehood-npm-cache npm run pack:check
```

## First Preview Publish

Publish only from a version tag:

```bash
git tag v0.1.0-preview.0
git push origin main --tags
```

The workflow publishes with:

```bash
npm publish --tag next
```

## Install Test

After the workflow publishes, test from a clean shell or temp directory:

```bash
npm install -g thehood@next
thehood --help
thehood doctor --repo .
```

Promote to `latest` only after external installs and public docs are verified.
