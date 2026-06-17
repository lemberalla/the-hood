import path from "node:path";

export interface ProjectPaths {
  repoPath: string;
  thehoodDir: string;
  configPath: string;
  runsDir: string;
}

export const resolveRepoPath = (repoPath: string): string => path.resolve(repoPath);

export const getProjectPaths = (repoPath: string): ProjectPaths => {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const thehoodDir = path.join(resolvedRepoPath, ".thehood");

  return {
    repoPath: resolvedRepoPath,
    thehoodDir,
    configPath: path.join(thehoodDir, "config.json"),
    runsDir: path.join(thehoodDir, "runs")
  };
};

