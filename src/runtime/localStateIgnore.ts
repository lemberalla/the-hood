import fs from "node:fs/promises";
import path from "node:path";
import { resolveRepoPath } from "./paths.js";

export const localStateIgnoreEntries = [
  ".thehood/",
  ".thehood-browser.json"
] as const;

export type LocalStateIgnoreStatus = "updated" | "already_ignored" | "not_git_repo";

export interface LocalStateIgnoreResult {
  status: LocalStateIgnoreStatus;
  addedEntries: string[];
  ignoredEntries: string[];
  excludePath?: string;
}

const sectionHeader = "# TheHood local runtime state";

const equivalentPatterns: Record<(typeof localStateIgnoreEntries)[number], string[]> = {
  ".thehood/": [".thehood/", ".thehood", "/.thehood/", "/.thehood"],
  ".thehood-browser.json": [".thehood-browser.json", "/.thehood-browser.json"]
};

const gitDirFromFile = async (repoPath: string, gitFilePath: string): Promise<string | undefined> => {
  const raw = await fs.readFile(gitFilePath, "utf8");
  const line = raw.split(/\r?\n/).find((value) => value.startsWith("gitdir:"));
  const gitDir = line?.slice("gitdir:".length).trim();

  if (!gitDir) {
    return undefined;
  }

  return path.isAbsolute(gitDir) ? gitDir : path.resolve(repoPath, gitDir);
};

const gitExcludePath = async (repoPathInput: string): Promise<string | undefined> => {
  const repoPath = resolveRepoPath(repoPathInput);
  const gitPath = path.join(repoPath, ".git");

  try {
    const stat = await fs.stat(gitPath);
    if (stat.isDirectory()) {
      return path.join(gitPath, "info", "exclude");
    }

    if (stat.isFile()) {
      const gitDir = await gitDirFromFile(repoPath, gitPath);
      return gitDir ? path.join(gitDir, "info", "exclude") : undefined;
    }

    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
};

const readExclude = async (excludePath: string): Promise<string> => {
  try {
    return await fs.readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
};

const activeExcludeLines = (content: string): string[] =>
  content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

const hasEntry = (lines: string[], entry: (typeof localStateIgnoreEntries)[number]): boolean =>
  equivalentPatterns[entry].some((pattern) => lines.includes(pattern));

const appendMissingEntries = (current: string, missingEntries: string[]): string => {
  const needsLeadingNewline = current.length > 0 && !current.endsWith("\n");
  const needsHeader = !current.split(/\r?\n/).some((line) => line.trim() === sectionHeader);

  return [
    current,
    needsLeadingNewline ? "\n" : "",
    needsHeader ? `${sectionHeader}\n` : "",
    `${missingEntries.join("\n")}\n`
  ].join("");
};

export const ensureLocalStateIgnored = async (repoPath: string): Promise<LocalStateIgnoreResult> => {
  const excludePath = await gitExcludePath(repoPath);

  if (!excludePath) {
    return {
      status: "not_git_repo",
      addedEntries: [],
      ignoredEntries: [...localStateIgnoreEntries]
    };
  }

  const current = await readExclude(excludePath);
  const lines = activeExcludeLines(current);
  const missingEntries = localStateIgnoreEntries.filter((entry) => !hasEntry(lines, entry));

  if (missingEntries.length === 0) {
    return {
      status: "already_ignored",
      addedEntries: [],
      ignoredEntries: [...localStateIgnoreEntries],
      excludePath
    };
  }

  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, appendMissingEntries(current, missingEntries), "utf8");

  return {
    status: "updated",
    addedEntries: missingEntries,
    ignoredEntries: [...localStateIgnoreEntries],
    excludePath
  };
};
