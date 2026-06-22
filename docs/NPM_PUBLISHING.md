# NPM Publishing

TheHood `v0.1.0-preview.0` is published as a developer-preview package. Future preview and stable packages should publish only after the public repo, CI, package boundary, and fresh-install behavior are reviewed.

Do not add npm tokens to the repository or GitHub Actions secrets. Use npm Trusted Publishing / OIDC for future tag-based workflow publishes.

## Before Publishing Another Version

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

## Preview Publish

Publish future preview versions from a version tag:

```bash
git tag v0.1.0-preview.1
git push origin main --tags
```

The workflow publishes with:

```bash
npm publish --tag next
```

## Install Test

After the workflow publishes, test from a clean shell or temp directory:

```bash
tmpdir=$(mktemp -d /private/tmp/thehood-install-smoke-XXXXXX)
cd "$tmpdir"
npm init -y
npm install thehood@next
./node_modules/.bin/thehood --help
./node_modules/.bin/thehood doctor --repo /path/to/repo
```

Because `v0.1.0-preview.0` is the first npm publish, npm `latest` can also resolve to the preview package. Public docs and examples should still use `thehood@next` until a stable release is intentionally promoted.
