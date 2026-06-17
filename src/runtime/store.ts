import fs from "node:fs/promises";
import path from "node:path";
import { getProjectPaths } from "./paths.js";
import type { RunRecord } from "./types.js";

const runFileName = "run.json";

const getRunDir = (repoPath: string, runId: string): string =>
  path.join(getProjectPaths(repoPath).runsDir, runId);

export const saveRun = async (run: RunRecord): Promise<void> => {
  const runDir = getRunDir(run.repoPath, run.runId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, runFileName), `${JSON.stringify(run, null, 2)}\n`, "utf8");
};

export const loadRun = async (repoPath: string, runId: string): Promise<RunRecord> => {
  const raw = await fs.readFile(path.join(getRunDir(repoPath, runId), runFileName), "utf8");
  return JSON.parse(raw) as RunRecord;
};

export const listRuns = async (repoPath: string): Promise<RunRecord[]> => {
  const runsDir = getProjectPaths(repoPath).runsDir;

  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const runDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const runs = await Promise.all(
      runDirs.map(async (runId) => {
        try {
          return await loadRun(repoPath, runId);
        } catch {
          return null;
        }
      })
    );

    return runs
      .filter((run): run is RunRecord => run !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
};

