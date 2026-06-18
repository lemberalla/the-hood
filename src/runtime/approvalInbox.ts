import type { RunArtifact, RunRecord } from "./types.js";

export interface PendingApprovalArtifact {
  kind: RunArtifact["kind"];
  ref: string;
  summary: string;
}

export interface PendingApproval {
  runId: string;
  createdAt: string;
  updatedAt: string;
  repoPath: string;
  mode: RunRecord["mode"];
  state: RunRecord["state"];
  goal: string;
  reason: string;
  suggestedApprovalMessage: string;
  artifacts: PendingApprovalArtifact[];
}

export const approvalMessageHint = (run: RunRecord): string => {
  const reason = run.approvalReason ?? "";
  const quoted = reason.match(/"([^"]+)"/)?.[1];

  if (quoted) {
    return `I approve ${quoted} for run ${run.runId}.`;
  }

  if (reason.includes("Implementation mode requires approval")) {
    return `I approve starting implementation for run ${run.runId}.`;
  }

  return `I approve the next TheHood transition for run ${run.runId}.`;
};

const artifactForRef = (run: RunRecord, artifactRef: unknown): PendingApprovalArtifact | undefined => {
  if (typeof artifactRef !== "string") {
    return undefined;
  }

  const artifact = run.artifacts.find((candidate) => candidate.ref === artifactRef);
  if (!artifact) {
    return undefined;
  }

  return {
    kind: artifact.kind,
    ref: artifact.ref,
    summary: artifact.summary
  };
};

const compactArtifacts = (artifacts: Array<PendingApprovalArtifact | undefined>): PendingApprovalArtifact[] => {
  const seen = new Set<string>();
  const compacted: PendingApprovalArtifact[] = [];

  for (const artifact of artifacts) {
    if (!artifact || seen.has(artifact.ref)) {
      continue;
    }

    seen.add(artifact.ref);
    compacted.push(artifact);
  }

  return compacted;
};

export const approvalArtifactsForRun = (run: RunRecord): PendingApprovalArtifact[] => {
  const approvalEvent = run.events.filter((event) => event.type === "approval_required").at(-1);
  const integrationReportEvent = run.events
    .filter((event) => event.type === "integration_report_written")
    .at(-1);

  return compactArtifacts([
    artifactForRef(run, approvalEvent?.data?.artifactRef),
    run.approvalReason?.includes("protected test changes")
      ? artifactForRef(run, integrationReportEvent?.data?.artifactRef)
      : undefined
  ]);
};

export const pendingApprovalForRun = (run: RunRecord): PendingApproval | undefined => {
  if (!run.approvalRequired) {
    return undefined;
  }

  return {
    runId: run.runId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    repoPath: run.repoPath,
    mode: run.mode,
    state: run.state,
    goal: run.userGoal,
    reason: run.approvalReason ?? "Approval is required before this run can continue.",
    suggestedApprovalMessage: approvalMessageHint(run),
    artifacts: approvalArtifactsForRun(run)
  };
};

export const pendingApprovalsFromRuns = (runs: RunRecord[]): PendingApproval[] =>
  runs
    .map(pendingApprovalForRun)
    .filter((approval): approval is PendingApproval => approval !== undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
