import fs from "node:fs/promises";
import path from "node:path";
import { getProjectPaths } from "./paths.js";
import type { RunArtifact, RunArtifactKind } from "./types.js";

export interface WriteArtifactInput {
  repoPath: string;
  runId: string;
  kind: RunArtifactKind;
  name: string;
  content: string;
  summary: string;
}

const safeArtifactName = (name: string): string =>
  name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "") || "artifact.txt";

export const writeRunArtifact = async (input: WriteArtifactInput): Promise<RunArtifact> => {
  const artifactDir = path.join(getProjectPaths(input.repoPath).artifactsDir, input.runId, input.kind);
  const artifactPath = path.join(artifactDir, safeArtifactName(input.name));

  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(artifactPath, input.content, "utf8");

  return {
    kind: input.kind,
    ref: artifactPath,
    summary: input.summary
  };
};

