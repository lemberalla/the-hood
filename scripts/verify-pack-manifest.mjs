import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const npmCache = process.env.THEHOOD_NPM_PACK_CACHE ?? fs.mkdtempSync(path.join(os.tmpdir(), "thehood-npm-pack-cache-"));

const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
  env: {
    ...process.env,
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache
  },
  stdio: ["ignore", "pipe", "pipe"]
});

assert.equal(result.status, 0, result.stderr || result.stdout);

const manifests = JSON.parse(result.stdout);
assert.ok(Array.isArray(manifests), "npm pack dry-run should return a JSON array.");
assert.equal(manifests.length, 1, "npm pack dry-run should return exactly one manifest.");

const manifest = manifests[0];
assert.equal(manifest.name, packageJson.name);
assert.equal(manifest.version, packageJson.version);
assert.equal(manifest.id, `${packageJson.name}@${packageJson.version}`);
assert.ok(Array.isArray(manifest.files), "npm pack manifest should include a files array.");

const paths = manifest.files.map((file) => file.path);
const pathSet = new Set(paths);

const requiredPaths = [
  "package.json",
  "README.md",
  "LICENSE",
  "PRIVACY.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "dist/cli/main.js",
  "dist/mcp/server.js",
  "dist/bridges/chatgptWebBridge.js",
  "docs/PUBLIC_REPO_READINESS.md",
  "docs/NPM_PUBLISHING.md",
  "examples/stub-demo/README.md"
];

const missingRequired = requiredPaths.filter((requiredPath) => !pathSet.has(requiredPath));
assert.deepEqual(missingRequired, [], `Missing required package paths: ${missingRequired.join(", ")}`);

const forbiddenChecks = [
  {
    label: ".thehood runtime state",
    matches: (filePath) => filePath === ".thehood" || filePath.startsWith(".thehood/")
  },
  {
    label: ".thehood-browser state",
    matches: (filePath) => filePath === ".thehood-browser.json"
  },
  {
    label: "source tree",
    matches: (filePath) => filePath === "src" || filePath.startsWith("src/")
  },
  {
    label: "node_modules",
    matches: (filePath) => filePath === "node_modules" || filePath.startsWith("node_modules/")
  },
  {
    label: "local env files",
    matches: (filePath) => filePath === ".env" || filePath.startsWith(".env.")
  },
  {
    label: "generated package archives",
    matches: (filePath) => filePath.endsWith(".tgz")
  },
  {
    label: "github workflow internals",
    matches: (filePath) => filePath === ".github" || filePath.startsWith(".github/")
  },
  {
    label: "static site draft",
    matches: (filePath) => filePath === "site" || filePath.startsWith("site/")
  }
];

const forbiddenHits = forbiddenChecks.flatMap((check) =>
  paths
    .filter((filePath) => check.matches(filePath))
    .map((filePath) => `${check.label}: ${filePath}`)
);
assert.deepEqual(forbiddenHits, [], `Forbidden package paths found: ${forbiddenHits.join(", ")}`);

console.log(
  `Pack manifest verified for ${manifest.id}: ${manifest.files.length} file(s), ${manifest.unpackedSize} unpacked byte(s).`
);
console.log(`Required paths present: ${requiredPaths.length}. Forbidden path checks passed: ${forbiddenChecks.length}.`);
