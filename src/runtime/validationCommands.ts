import fs from "node:fs/promises";
import path from "node:path";
import { writeRunArtifact } from "./artifacts.js";
import { runRuntimeCommand } from "./commandRunner.js";
import { newId, nowIso } from "./ids.js";
import { resolveRepoPath } from "./paths.js";
import { loadRun, saveRun } from "./store.js";
import type { RunArtifact, RunEvent, RunRecord, ToolEvent } from "./types.js";

export interface ValidationCommand {
  script: string;
  command: string;
  args: string[];
}

export interface ValidationCommandResult extends ValidationCommand {
  event: ToolEvent;
}

export interface ValidationEvidenceResult {
  run: RunRecord;
  discoveredCommands: ValidationCommand[];
  executedCommands: ValidationCommandResult[];
  failedCommands: ValidationCommandResult[];
  artifact: RunArtifact;
}

interface PackageJson {
  scripts?: Record<string, unknown>;
}

const preferredValidationScripts = ["typecheck", "test", "lint", "build"] as const;

const createEvent = (type: string, message: string, data?: RunEvent["data"]): RunEvent => ({
  id: newId("event"),
  createdAt: nowIso(),
  type,
  message,
  ...(data ? { data } : {})
});

const readPackageJson = async (repoPath: string): Promise<PackageJson | undefined> => {
  try {
    const raw = await fs.readFile(path.join(repoPath, "package.json"), "utf8");
    return JSON.parse(raw) as PackageJson;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
};

export const discoverValidationCommands = async (
  repoPathInput: string
): Promise<ValidationCommand[]> => {
  const repoPath = resolveRepoPath(repoPathInput);
  const packageJson = await readPackageJson(repoPath);
  const scripts = packageJson?.scripts ?? {};

  return preferredValidationScripts.flatMap((script) =>
    typeof scripts[script] === "string"
      ? [
          {
            script,
            command: "npm",
            args: ["run", script]
          }
        ]
      : []
  );
};

export const captureValidationEvidence = async (
  run: RunRecord
): Promise<ValidationEvidenceResult> => {
  const discoveredCommands = await discoverValidationCommands(run.repoPath);
  const selectedCommands = discoveredCommands.slice(0, 1);
  const executedCommands: ValidationCommandResult[] = [];
  let latestRun = run;

  for (const command of selectedCommands) {
    const result = await runRuntimeCommand({
      repoPath: latestRun.repoPath,
      runId: latestRun.runId,
      tool: `validation_${command.script}`,
      command: command.command,
      args: command.args
    });
    latestRun = result.run;
    executedCommands.push({
      ...command,
      event: result.event
    });
  }

  const failedCommands = executedCommands.filter((command) => command.event.exitCode !== 0);
  const artifact = await writeRunArtifact({
    repoPath: latestRun.repoPath,
    runId: latestRun.runId,
    kind: "metadata",
    name: "validation-summary.json",
    content: `${JSON.stringify(
      {
        discoveredCommands,
        executedCommands: executedCommands.map((command) => ({
          script: command.script,
          command: command.command,
          args: command.args,
          toolEventId: command.event.id,
          exitCode: command.event.exitCode,
          stdoutRef: command.event.stdoutRef,
          stderrRef: command.event.stderrRef
        })),
        failedCommandCount: failedCommands.length
      },
      null,
      2
    )}\n`,
    summary: `Validation summary for ${executedCommands.length} command(s), ${failedCommands.length} failed.`
  });

  const currentRun = await loadRun(latestRun.repoPath, latestRun.runId);
  const updated: RunRecord = {
    ...currentRun,
    updatedAt: nowIso(),
    artifacts: [...currentRun.artifacts, artifact],
    events: [
      ...currentRun.events,
      createEvent("validation_evidence_captured", "Captured runtime validation evidence.", {
        discoveredCommandCount: discoveredCommands.length,
        executedCommandCount: executedCommands.length,
        failedCommandCount: failedCommands.length,
        artifactRef: artifact.ref
      })
    ]
  };

  await saveRun(updated);

  return {
    run: updated,
    discoveredCommands,
    executedCommands,
    failedCommands,
    artifact
  };
};
