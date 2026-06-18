import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { InputError } from "./errors.js";
import { resolveRepoPath } from "./paths.js";

export interface RepoTreeEntry {
  path: string;
  type: "file" | "directory";
  bytes?: number;
}

export interface RepoTreeResult {
  repoPath: string;
  root: string;
  entries: RepoTreeEntry[];
  omittedEntryCount: number;
}

export interface RepoReadFileResult {
  repoPath: string;
  path: string;
  offset: number;
  byteLength: number;
  truncated: boolean;
  content: string;
}

export interface RepoSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface RepoSearchResult {
  repoPath: string;
  query: string;
  matches: RepoSearchMatch[];
  omittedMatchCount: number;
}

export interface GitCommandResult {
  repoPath: string;
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

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

const defaultMaxEntries = 200;
const defaultMaxDepth = 4;
const defaultMaxReadBytes = 20_000;
const maxSearchFileBytes = 200_000;

const toPosixPath = (value: string): string => value.split(path.sep).join("/");

const isIgnoredPath = (relativePath: string): boolean => {
  const normalized = toPosixPath(relativePath).replace(/\/$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.some((part) => ignoredPathParts.has(part)) || secretPathPatterns.some((pattern) => pattern.test(normalized));
};

const isTextLike = (buffer: Buffer): boolean => !buffer.includes(0);

const clampPositiveInteger = (value: number | undefined, fallback: number, max: number): number => {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InputError("numeric limits must be positive integers.");
  }

  return Math.min(value, max);
};

const assertPathInside = (basePath: string, candidatePath: string): void => {
  const relativePath = toPosixPath(path.relative(basePath, candidatePath));

  if (candidatePath !== basePath && (relativePath === ".." || relativePath.startsWith("../") || path.isAbsolute(relativePath))) {
    throw new InputError("repo path escapes repo_path.");
  }
};

const resolveSafeRepoPath = async (
  repoPathInput: string,
  requestedPath = "."
): Promise<{ repoPath: string; absolutePath: string; relativePath: string }> => {
  const repoPath = resolveRepoPath(repoPathInput);
  const normalizedRequest = requestedPath.trim().length > 0 ? requestedPath : ".";

  if (path.isAbsolute(normalizedRequest)) {
    throw new InputError("repo paths must be relative to repo_path.");
  }

  const absolutePath = path.resolve(repoPath, normalizedRequest);
  const relativePath = toPosixPath(path.relative(repoPath, absolutePath));

  assertPathInside(repoPath, absolutePath);

  if (isIgnoredPath(relativePath)) {
    throw new InputError(`repo path is not readable through the gateway: ${relativePath}`);
  }

  const repoRealPath = await fs.realpath(repoPath);
  const absoluteRealPath = await fs.realpath(absolutePath);
  assertPathInside(repoRealPath, absoluteRealPath);

  return {
    repoPath,
    absolutePath,
    relativePath: relativePath === "" ? "." : relativePath
  };
};

const globToRegExp = (glob: string): RegExp => {
  const normalized = toPosixPath(glob);
  let pattern = "";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];

    if (char === "*" && next === "*") {
      if (afterNext === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
      continue;
    }

    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }

    if (char === "?") {
      pattern += "[^/]";
      continue;
    }

    pattern += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }

  return new RegExp(`^${pattern}$`);
};

const matchesGlobs = (relativePath: string, globs: string[]): boolean => {
  if (globs.length === 0) {
    return true;
  }

  return globs.some((glob) => globToRegExp(glob).test(relativePath));
};

const walkTree = async (
  repoPath: string,
  root: string,
  current: string,
  depth: number,
  maxDepth: number,
  entries: RepoTreeEntry[],
  maxEntries: number
): Promise<number> => {
  if (depth > maxDepth) {
    return 0;
  }

  const absoluteDir = path.join(repoPath, current);
  const dirEntries = await fs.readdir(absoluteDir, { withFileTypes: true });
  let omitted = 0;

  for (const entry of dirEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = toPosixPath(path.join(current, entry.name));
    if (isIgnoredPath(relativePath)) {
      continue;
    }

    if (entries.length >= maxEntries) {
      omitted += 1;
      continue;
    }

    if (entry.isDirectory()) {
      entries.push({
        path: `${relativePath}/`,
        type: "directory"
      });
      omitted += await walkTree(repoPath, root, relativePath, depth + 1, maxDepth, entries, maxEntries);
      continue;
    }

    if (entry.isFile()) {
      const stat = await fs.stat(path.join(repoPath, relativePath));
      entries.push({
        path: relativePath,
        type: "file",
        bytes: stat.size
      });
    }
  }

  return omitted;
};

const walkFiles = async (repoPath: string, current = "."): Promise<string[]> => {
  const absoluteDir = current === "." ? repoPath : path.join(repoPath, current);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = toPosixPath(path.join(current, entry.name).replace(/^\.\//, ""));
    if (isIgnoredPath(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...await walkFiles(repoPath, relativePath));
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
};

const runGit = async (repoPath: string, args: string[], maxBytes: number): Promise<GitCommandResult> => {
  const command = "git";
  const child = spawn(command, args, {
    cwd: repoPath,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let truncated = false;

  const appendBounded = (current: Buffer, chunk: Buffer): Buffer => {
    const next = Buffer.concat([current, chunk]);
    if (next.byteLength <= maxBytes) {
      return next;
    }

    truncated = true;
    return next.subarray(0, maxBytes);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", (error) => {
      reject(new InputError(`failed to run git: ${error.message}`));
    });
    child.on("close", (code) => resolve(code ?? 1));
  });

  return {
    repoPath,
    command,
    args,
    exitCode,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
    truncated
  };
};

export const listRepoTree = async (input: {
  repoPath: string;
  path?: string;
  maxDepth?: number;
  maxEntries?: number;
}): Promise<RepoTreeResult> => {
  const maxDepth = clampPositiveInteger(input.maxDepth, defaultMaxDepth, 20);
  const maxEntries = clampPositiveInteger(input.maxEntries, defaultMaxEntries, 1_000);
  const resolved = await resolveSafeRepoPath(input.repoPath, input.path);
  const stat = await fs.stat(resolved.absolutePath);

  if (!stat.isDirectory()) {
    throw new InputError("repo tree path must be a directory.");
  }

  const entries: RepoTreeEntry[] = [];
  const root = resolved.relativePath;
  const omittedEntryCount = await walkTree(resolved.repoPath, root, root === "." ? "." : root, 1, maxDepth, entries, maxEntries);

  return {
    repoPath: resolved.repoPath,
    root,
    entries,
    omittedEntryCount
  };
};

export const readRepoFile = async (input: {
  repoPath: string;
  path: string;
  offset?: number;
  maxBytes?: number;
}): Promise<RepoReadFileResult> => {
  const maxBytes = clampPositiveInteger(input.maxBytes, defaultMaxReadBytes, 200_000);
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new InputError("offset must be a non-negative integer.");
  }

  const resolved = await resolveSafeRepoPath(input.repoPath, input.path);
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new InputError("repo read path must be a file.");
  }

  const buffer = await fs.readFile(resolved.absolutePath);
  if (!isTextLike(buffer)) {
    throw new InputError("repo read path is not a text file.");
  }

  const sliced = buffer.subarray(offset, offset + maxBytes);

  return {
    repoPath: resolved.repoPath,
    path: resolved.relativePath,
    offset,
    byteLength: buffer.byteLength,
    truncated: offset + sliced.byteLength < buffer.byteLength,
    content: sliced.toString("utf8")
  };
};

export const searchRepo = async (input: {
  repoPath: string;
  query: string;
  globs?: string[];
  maxResults?: number;
  caseSensitive?: boolean;
}): Promise<RepoSearchResult> => {
  const repoPath = resolveRepoPath(input.repoPath);
  const query = input.caseSensitive === false ? input.query.toLowerCase() : input.query;
  const maxResults = clampPositiveInteger(input.maxResults, 50, 500);
  const globs = input.globs ?? [];
  const matches: RepoSearchMatch[] = [];
  let omittedMatchCount = 0;

  if (input.query.trim().length === 0) {
    throw new InputError("query must be a non-empty string.");
  }

  for (const relativePath of await walkFiles(repoPath)) {
    if (!matchesGlobs(relativePath, globs)) {
      continue;
    }

    const absolutePath = path.join(repoPath, relativePath);
    const stat = await fs.stat(absolutePath);
    if (stat.size > maxSearchFileBytes) {
      continue;
    }

    const buffer = await fs.readFile(absolutePath);
    if (!isTextLike(buffer)) {
      continue;
    }

    const lines = buffer.toString("utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      const haystack = input.caseSensitive === false ? line.toLowerCase() : line;
      if (!haystack.includes(query)) {
        continue;
      }

      if (matches.length >= maxResults) {
        omittedMatchCount += 1;
        continue;
      }

      matches.push({
        path: relativePath,
        line: index + 1,
        text: line
      });
    }
  }

  return {
    repoPath,
    query: input.query,
    matches,
    omittedMatchCount
  };
};

export const getRepoGitStatus = async (repoPathInput: string): Promise<GitCommandResult> => {
  const repoPath = resolveRepoPath(repoPathInput);
  return runGit(repoPath, ["status", "--short", "--untracked-files=all", "--", ".", ":(exclude).thehood"], defaultMaxReadBytes);
};

export const getRepoGitDiff = async (input: {
  repoPath: string;
  path?: string;
  maxBytes?: number;
}): Promise<GitCommandResult> => {
  const repoPath = resolveRepoPath(input.repoPath);
  const maxBytes = clampPositiveInteger(input.maxBytes, defaultMaxReadBytes, 200_000);
  const args = ["diff", "--no-ext-diff", "--"];

  if (input.path) {
    const resolved = await resolveSafeRepoPath(repoPath, input.path);
    args.push(resolved.relativePath);
  } else {
    args.push(".", ":(exclude).thehood");
  }

  return runGit(repoPath, args, maxBytes);
};
