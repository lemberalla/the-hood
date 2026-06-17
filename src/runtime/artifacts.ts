import fs from "node:fs/promises";
import path from "node:path";
import { getProjectPaths } from "./paths.js";
import { loadRun } from "./store.js";
import { InputError, PermissionDeniedError } from "./errors.js";
import type { RunArtifact, RunArtifactKind } from "./types.js";

export interface WriteArtifactInput {
  repoPath: string;
  runId: string;
  kind: RunArtifactKind;
  name: string;
  content: string;
  summary: string;
}

export interface ReadArtifactInput {
  repoPath: string;
  runId: string;
  ref: string;
  maxBytes?: number;
}

export interface ReadArtifactResult {
  artifact: RunArtifact;
  content: string;
  truncated: boolean;
  byteLength: number;
}

const safeArtifactName = (name: string): string =>
  name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "") || "artifact.txt";

const maxArtifactReadBytes = 200_000;

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

const assertArtifactPath = (repoPath: string, runId: string, ref: string): string => {
  const artifactRoot = path.join(getProjectPaths(repoPath).artifactsDir, runId);
  const resolved = path.resolve(ref);
  const relative = path.relative(artifactRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PermissionDeniedError(`Artifact ref is outside this run's artifact directory: ${ref}`);
  }

  return resolved;
};

export const readRunArtifact = async (input: ReadArtifactInput): Promise<ReadArtifactResult> => {
  const run = await loadRun(input.repoPath, input.runId);
  const artifact = run.artifacts.find((candidate) => candidate.ref === input.ref);

  if (!artifact) {
    throw new InputError(`Artifact ref is not attached to run ${input.runId}.`);
  }

  const artifactPath = assertArtifactPath(input.repoPath, input.runId, input.ref);
  const raw = await fs.readFile(artifactPath);
  const requestedMaxBytes = input.maxBytes ?? 20_000;
  const maxBytes = Math.min(Math.max(1, requestedMaxBytes), maxArtifactReadBytes);
  const sliced = raw.subarray(0, maxBytes);

  return {
    artifact,
    content: sliced.toString("utf8"),
    truncated: raw.byteLength > maxBytes,
    byteLength: raw.byteLength
  };
};
