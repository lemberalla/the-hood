import { nowIso } from "./ids.js";
import { formatRoleAssignment } from "./role-assignment.js";
import { listRuns } from "./store.js";
import type { JsonObject, RoleMap, RunArtifact, RunRecord, RunState } from "./types.js";

export interface CanonicalMemoryArtifactRefs {
  latestAgentResponse?: CanonicalMemoryArtifactRef;
  latestPlan?: CanonicalMemoryArtifactRef;
  latestProgressPacket?: CanonicalMemoryArtifactRef;
  latestReconciliation?: CanonicalMemoryArtifactRef;
  latestRepoContext?: CanonicalMemoryArtifactRef;
  latestRemoteRepoContext?: CanonicalMemoryArtifactRef;
  latestFinalReport?: CanonicalMemoryArtifactRef;
  latestCriticTrigger?: CanonicalMemoryArtifactRef;
  latestRevisionPacket?: CanonicalMemoryArtifactRef;
  latestFanout?: CanonicalMemoryArtifactRef;
  latestTransferManifest?: CanonicalMemoryArtifactRef;
}

export interface CanonicalMemoryArtifactRef {
  kind: RunArtifact["kind"];
  ref: string;
  summary: string;
}

const maxRecentRuns = 5;
const maxGoalLength = 500;
const terminalStates = new Set<RunState>(["completed", "failed", "aborted"]);
const agentResponseKinds = new Set<RunArtifact["kind"]>(["plan", "agent", "reconciliation"]);

const truncateText = (value: string, maxLength = maxGoalLength): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;

const summarizeArtifact = (artifact: RunArtifact): CanonicalMemoryArtifactRef => ({
  kind: artifact.kind,
  ref: artifact.ref,
  summary: artifact.summary
});

const latestArtifact = (
  run: RunRecord,
  predicate: (artifact: RunArtifact) => boolean
): CanonicalMemoryArtifactRef | undefined => {
  const artifact = run.artifacts.filter(predicate).at(-1);
  return artifact ? summarizeArtifact(artifact) : undefined;
};

const latestFinalReport = (run: RunRecord): CanonicalMemoryArtifactRef | undefined =>
  latestArtifact(
    run,
    (artifact) => artifact.kind === "report" && artifact.summary.toLowerCase().includes("final report")
  ) ?? latestArtifact(run, (artifact) => artifact.kind === "report");

export const latestCanonicalArtifactRefs = (run: RunRecord): CanonicalMemoryArtifactRefs => {
  const latestAgentResponse = latestArtifact(run, (artifact) => agentResponseKinds.has(artifact.kind));
  const latestPlan = latestArtifact(run, (artifact) => artifact.kind === "plan");
  const latestProgressPacket = latestArtifact(run, (artifact) => artifact.kind === "progress");
  const latestReconciliation = latestArtifact(run, (artifact) => artifact.kind === "reconciliation");
  const latestRepoContext = latestArtifact(run, (artifact) => artifact.kind === "context");
  const latestRemoteRepoContext = latestArtifact(run, (artifact) => artifact.kind === "remote_context");
  const latestCriticTrigger = latestArtifact(run, (artifact) => artifact.kind === "critic_trigger");
  const latestRevisionPacket = latestArtifact(run, (artifact) => artifact.kind === "revision_packet");
  const latestFanout = latestArtifact(run, (artifact) => artifact.kind === "fanout");
  const latestTransferManifest = latestArtifact(run, (artifact) => artifact.kind === "transfer_manifest");
  const finalReport = latestFinalReport(run);

  return {
    ...(latestAgentResponse ? { latestAgentResponse } : {}),
    ...(latestPlan ? { latestPlan } : {}),
    ...(latestProgressPacket ? { latestProgressPacket } : {}),
    ...(latestReconciliation ? { latestReconciliation } : {}),
    ...(latestRepoContext ? { latestRepoContext } : {}),
    ...(latestRemoteRepoContext ? { latestRemoteRepoContext } : {}),
    ...(finalReport ? { latestFinalReport: finalReport } : {}),
    ...(latestCriticTrigger ? { latestCriticTrigger } : {}),
    ...(latestRevisionPacket ? { latestRevisionPacket } : {}),
    ...(latestFanout ? { latestFanout } : {}),
    ...(latestTransferManifest ? { latestTransferManifest } : {})
  };
};

const roleAssignments = (roles: RoleMap): JsonObject =>
  Object.fromEntries(
    Object.entries(roles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([role, assignment]) => [role, formatRoleAssignment(assignment)])
  );

const summarizeRun = (run: RunRecord): JsonObject => ({
  runId: run.runId,
  mode: run.mode,
  state: run.state,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  userGoal: truncateText(run.userGoal),
  approvalRequired: run.approvalRequired,
  ...(run.approvalReason ? { approvalReason: truncateText(run.approvalReason) } : {}),
  ...(run.stopReason ? { stopReason: truncateText(run.stopReason) } : {}),
  terminal: terminalStates.has(run.state),
  roleAssignments: roleAssignments(run.roleMapping),
  artifacts: latestCanonicalArtifactRefs(run) as JsonObject
});

const latestProjectArtifact = (
  runs: RunRecord[],
  key: keyof CanonicalMemoryArtifactRefs
): JsonObject | undefined => {
  for (const run of runs) {
    const artifact = latestCanonicalArtifactRefs(run)[key];
    if (artifact) {
      return {
        runId: run.runId,
        artifact: {
          kind: artifact.kind,
          ref: artifact.ref,
          summary: artifact.summary
        }
      };
    }
  }

  return undefined;
};

const projectRunsForMemory = async (run: RunRecord): Promise<RunRecord[]> => {
  const runs = await listRuns(run.repoPath);
  const runsById = new Map(runs.map((candidate) => [candidate.runId, candidate]));
  runsById.set(run.runId, run);

  return Array.from(runsById.values())
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, maxRecentRuns);
};

export const buildCanonicalMemory = async (run: RunRecord): Promise<JsonObject> => {
  const recentRuns = await projectRunsForMemory(run);
  const projectLatest: JsonObject = {};

  for (const key of [
    "latestProgressPacket",
    "latestReconciliation",
    "latestRepoContext",
    "latestRemoteRepoContext",
    "latestFinalReport",
    "latestRevisionPacket",
    "latestFanout",
    "latestTransferManifest"
  ] as const) {
    const artifact = latestProjectArtifact(recentRuns, key);
    if (artifact) {
      projectLatest[key] = artifact;
    }
  }

  return {
    schemaVersion: 1,
    kind: "canonical_memory",
    generatedAt: nowIso(),
    repoPath: run.repoPath,
    artifactBodyPolicy: "refs_only",
    ignoreProviderSessionContext: true,
    instructions: [
      "Treat TheHood runtime state and artifact refs as authoritative.",
      "Ignore stale browser, chat, or provider session context unless it is repeated in this canonicalMemory or the current directive context.",
      "Use artifact refs, including local and remote repo context refs, to ask the runtime for more evidence; do not assume large artifact bodies are present here.",
      "This object is a bounded project memory index, not a memory engine."
    ],
    currentRun: summarizeRun(run),
    projectLatest,
    recentRuns: recentRuns.map(summarizeRun),
    bounds: {
      maxRecentRuns,
      includedRecentRuns: recentRuns.length,
      artifactBodiesIncluded: false,
      maxTextFieldLength: maxGoalLength
    }
  };
};
