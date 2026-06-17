import path from "node:path";

export interface ProtectedPathMatch {
  path: string;
  pattern: string;
}

const normalizePath = (filePath: string): string =>
  filePath.split(path.sep).join("/").replace(/^\.\//, "");

const escapeRegex = (char: string): string => char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

const globToRegex = (pattern: string): RegExp => {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];

    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }

    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegex(char ?? "");
  }

  return new RegExp(`^${source}$`);
};

export const matchProtectedPath = (
  filePath: string,
  patterns: string[]
): ProtectedPathMatch | undefined => {
  const normalizedPath = normalizePath(filePath);

  for (const pattern of patterns) {
    if (globToRegex(normalizePath(pattern)).test(normalizedPath)) {
      return {
        path: normalizedPath,
        pattern
      };
    }
  }

  return undefined;
};

export const findProtectedPathMatches = (
  filePaths: string[],
  patterns: string[]
): ProtectedPathMatch[] =>
  filePaths.flatMap((filePath) => {
    const match = matchProtectedPath(filePath, patterns);
    return match ? [match] : [];
  });

