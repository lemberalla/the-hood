import fs from "node:fs/promises";
import path from "node:path";
import { writeRunArtifact } from "./artifacts.js";
import { newId, nowIso } from "./ids.js";
import { resolveRepoPath } from "./paths.js";
import { loadRun, saveRun } from "./store.js";
import type { JsonObject, JsonValue, RunArtifact, RunRecord } from "./types.js";

export interface RepoContextFile {
  path: string;
  bytes: number;
  truncated: boolean;
  excerpt: string;
}

export interface RepoContextPack {
  schemaVersion: 1;
  kind: "repo_context";
  generatedAt: string;
  repoPath: string;
  runId: string;
  goal: string;
  delegate: JsonObject;
  limits: {
    maxTreePaths: number;
    maxFiles: number;
    maxBytesPerFile: number;
    maxTotalBytes: number;
  };
  tree: string[];
  omittedTreePathCount: number;
  files: RepoContextFile[];
  notes: string[];
}

export interface CaptureRepoContextResult {
  run: RunRecord;
  artifact: RunArtifact;
  context: RepoContextPack;
}

const priorityPaths = [
  "AGENTS.md",
  "README.md",
  "package.json",
  "tsconfig.json",
  "docs/ARCHITECTURE.md",
  "docs/RUNTIME_LOOP.md",
  "docs/ROLE_CONTRACTS.md",
  "docs/PROVIDER_ADAPTERS.md",
  "docs/MCP_SPEC.md",
  "docs/CLI_SPEC.md",
  "docs/ROADMAP.md",
  "docs/OPEN_DECISIONS.md",
  "src/runtime/loop.ts",
  "src/runtime/directives.ts",
  "src/runtime/types.ts",
  "src/providers/router.ts",
  "src/providers/types.ts",
  "src/providers/localCommand.ts",
  "src/providers/chatgptWeb.ts",
  "src/providers/stub.ts",
  "src/mcp/tools.ts",
  "scripts/smoke-runtime.mjs",
  "scripts/smoke-mcp.mjs"
];

const ignoredPathParts = new Set([
  ".git",
  ".thehood",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo"
]);

const secretPathPatterns = [
  /^\.env(?:\.|$)/,
  /(?:^|[/.-])secret(?:s)?(?:[/.-]|$)/i,
  /(?:^|[/.-])token(?:s)?(?:[/.-]|$)/i,
  /(?:^|[/.-])credential(?:s)?(?:[/.-]|$)/i,
  /\.(?:pem|key|p12|pfx|crt|cer)$/i,
  /id_rsa$/i,
  /id_ed25519$/i
];

const maxTreePaths = 300;
const maxFiles = 24;
const maxBytesPerFile = 4_000;
const maxTotalBytes = 60_000;

const toPosixPath = (value: string): string => value.split(path.sep).join("/");

const isIgnoredPath = (relativePath: string): boolean => {
  const parts = relativePath.split("/");
  return parts.some((part) => ignoredPathParts.has(part)) || secretPathPatterns.some((pattern) => pattern.test(relativePath));
};

const isTextLike = (buffer: Buffer): boolean => !buffer.includes(0);

const walkRepo = async (repoPath: string, dir = "."): Promise<string[]> => {
  const absoluteDir = path.join(repoPath, dir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = toPosixPath(path.join(dir, entry.name).replace(/^\.\//, ""));

    if (isIgnoredPath(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      paths.push(`${relativePath}/`);
      paths.push(...await walkRepo(repoPath, relativePath));
      continue;
    }

    if (entry.isFile()) {
      paths.push(relativePath);
    }
  }

  return paths;
};

const scorePath = (relativePath: string): number => {
  if (priorityPaths.includes(relativePath)) {
    return 0;
  }

  if (relativePath.startsWith("src/providers/")) {
    return 1;
  }

  if (relativePath.startsWith("src/runtime/")) {
    return 2;
  }

  if (relativePath.startsWith("src/mcp/")) {
    return 3;
  }

  if (relativePath.startsWith("docs/")) {
    return 4;
  }

  if (relativePath.startsWith("scripts/")) {
    return 5;
  }

  return 10;
};

const selectCandidateFiles = (tree: string[]): string[] => {
  const files = tree.filter((relativePath) => !relativePath.endsWith("/"));
  const priority = priorityPaths.filter((relativePath) => files.includes(relativePath));
  const scored = files
    .filter((relativePath) => !priority.includes(relativePath))
    .filter((relativePath) => scorePath(relativePath) < 10)
    .sort((left, right) => scorePath(left) - scorePath(right) || left.localeCompare(right));

  return Array.from(new Set([...priority, ...scored])).slice(0, maxFiles);
};

const readContextFile = async (repoPath: string, relativePath: string): Promise<RepoContextFile | undefined> => {
  const absolutePath = path.join(repoPath, relativePath);
  const buffer = await fs.readFile(absolutePath);

  if (!isTextLike(buffer)) {
    return undefined;
  }

  const sliced = buffer.subarray(0, maxBytesPerFile);

  return {
    path: relativePath,
    bytes: buffer.byteLength,
    truncated: buffer.byteLength > maxBytesPerFile,
    excerpt: sliced.toString("utf8")
  };
};

const boundedFileExcerpts = async (repoPath: string, candidates: string[]): Promise<RepoContextFile[]> => {
  const files: RepoContextFile[] = [];
  let totalBytes = 0;

  for (const relativePath of candidates) {
    const file = await readContextFile(repoPath, relativePath);
    if (!file) {
      continue;
    }

    const nextTotalBytes = totalBytes + file.excerpt.length;
    if (nextTotalBytes > maxTotalBytes) {
      break;
    }

    files.push(file);
    totalBytes = nextTotalBytes;
  }

  return files;
};

const normalizeDelegate = (delegate: JsonValue | undefined): JsonObject =>
  delegate && typeof delegate === "object" && !Array.isArray(delegate) ? delegate : {};

export const captureRepoContext = async (
  run: RunRecord,
  delegate: JsonValue | undefined
): Promise<CaptureRepoContextResult> => {
  const repoPath = resolveRepoPath(run.repoPath);
  const tree = await walkRepo(repoPath);
  const context: RepoContextPack = {
    schemaVersion: 1,
    kind: "repo_context",
    generatedAt: nowIso(),
    repoPath,
    runId: run.runId,
    goal: run.userGoal,
    delegate: normalizeDelegate(delegate),
    limits: {
      maxTreePaths,
      maxFiles,
      maxBytesPerFile,
      maxTotalBytes
    },
    tree: tree.slice(0, maxTreePaths),
    omittedTreePathCount: Math.max(0, tree.length - maxTreePaths),
    files: await boundedFileExcerpts(repoPath, selectCandidateFiles(tree)),
    notes: [
      "This context pack was captured by deterministic runtime code.",
      "Ignored paths include .git, .thehood, node_modules, dist, build, coverage, and secret-looking filenames.",
      "File excerpts are bounded and may be truncated."
    ]
  };
  const artifact = await writeRunArtifact({
    repoPath,
    runId: run.runId,
    kind: "context",
    name: `repo-context-${newId("context")}.json`,
    content: `${JSON.stringify(context, null, 2)}\n`,
    summary: `Repo context pack with ${context.files.length} file excerpt(s) and ${context.tree.length} tree path(s).`
  });
  const latestRun = await loadRun(repoPath, run.runId);
  const updated: RunRecord = {
    ...latestRun,
    updatedAt: nowIso(),
    artifacts: [...latestRun.artifacts, artifact],
    events: [
      ...latestRun.events,
      {
        id: newId("event"),
        createdAt: nowIso(),
        type: "repo_context_captured",
        message: `Captured repo context for ${context.files.length} file excerpt(s).`,
        data: {
          fileCount: context.files.length,
          treePathCount: context.tree.length,
          artifactRef: artifact.ref
        }
      }
    ]
  };

  await saveRun(updated);

  return {
    run: updated,
    artifact,
    context
  };
};

export const latestRepoContextArtifact = (run: RunRecord): RunArtifact | undefined =>
  run.artifacts.filter((artifact) => artifact.kind === "context").at(-1);

export const readLatestRepoContext = async (run: RunRecord): Promise<RepoContextPack | undefined> => {
  const artifact = latestRepoContextArtifact(run);

  if (!artifact) {
    return undefined;
  }

  const raw = await fs.readFile(artifact.ref, "utf8");
  return JSON.parse(raw) as RepoContextPack;
};
