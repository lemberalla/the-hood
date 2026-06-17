import { writeRunArtifact } from "./artifacts.js";
import { runRuntimeCommand } from "./commandRunner.js";
import { loadConfig } from "./config.js";
import { newId, nowIso } from "./ids.js";
import { findProtectedPathMatches, type ProtectedPathMatch } from "./protectedPaths.js";
import { resolveRepoPath } from "./paths.js";
import { loadRun, saveRun } from "./store.js";
import type { RunArtifact, RunRecord } from "./types.js";

export interface GitEvidenceResult {
  run: RunRecord;
  changedPaths: string[];
  protectedChanges: ProtectedPathMatch[];
  artifacts: RunArtifact[];
}

const parseStatusPath = (line: string): string[] => {
  const payload = line.slice(3).trim();
  if (!payload) return [];

  if (payload.includes(" -> ")) {
    return payload.split(" -> ").map((value) => value.trim()).filter(Boolean);
  }

  return [payload.replace(/^"|"$/g, "")];
};

export const parseGitStatusPaths = (stdout: string): string[] =>
  Array.from(
    new Set(
      stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap(parseStatusPath)
    )
  ).sort((left, right) => left.localeCompare(right));

export const captureGitEvidence = async (
  repoPathInput: string,
  runId: string
): Promise<GitEvidenceResult> => {
  const repoPath = resolveRepoPath(repoPathInput);
  const config = await loadConfig(repoPath);

  const statusResult = await runRuntimeCommand({
    repoPath,
    runId,
    tool: "git_status",
    command: "git",
    args: ["status", "--short", "--untracked-files=all", "--", ".", ":(exclude).thehood"]
  });
  const diffResult = await runRuntimeCommand({
    repoPath,
    runId,
    tool: "git_diff",
    command: "git",
    args: ["diff", "--no-ext-diff", "--", ".", ":(exclude).thehood"]
  });
  const changedPaths = parseGitStatusPaths(statusResult.stdout);
  const protectedChanges = findProtectedPathMatches(changedPaths, config.defaults.protectedTestPaths);
  const summaryArtifact = await writeRunArtifact({
    repoPath,
    runId,
    kind: "metadata",
    name: "git-evidence-summary.json",
    content: `${JSON.stringify(
      {
        changedPaths,
        protectedChanges,
        statusRef: statusResult.event.stdoutRef,
        diffRef: diffResult.event.stdoutRef
      },
      null,
      2
    )}\n`,
    summary: `Git evidence summary for ${changedPaths.length} changed path(s).`
  });

  const run = await loadRun(repoPath, runId);
  const updated: RunRecord = {
    ...run,
    updatedAt: nowIso(),
    artifacts: [...run.artifacts, summaryArtifact],
    events: [
      ...run.events,
      {
        id: newId("event"),
        createdAt: nowIso(),
        type: "git_evidence_captured",
        message: `Captured git evidence for ${changedPaths.length} changed path(s).`,
        data: {
          changedPathCount: changedPaths.length,
          protectedChangeCount: protectedChanges.length
        }
      }
    ]
  };

  await saveRun(updated);

  return {
    run: updated,
    changedPaths,
    protectedChanges,
    artifacts: [summaryArtifact]
  };
};
