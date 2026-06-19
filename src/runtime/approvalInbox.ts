import type { JsonObject, RunArtifact, RunEvent, RunRecord } from "./types.js";

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

export interface AutopilotApproval {
  runId: string;
  createdAt: string;
  updatedAt: string;
  repoPath: string;
  mode: RunRecord["mode"];
  state: RunRecord["state"];
  goal: string;
  message: string;
  gate?: string;
  gateReason?: string;
  policyDecision?: string;
  policyReason?: string;
  artifact?: PendingApprovalArtifact;
  sourceArtifact?: PendingApprovalArtifact;
  transfer?: JsonObject;
}

export interface ApprovalInboxView {
  pendingApprovals: PendingApproval[];
  recentAutopilotApprovals: AutopilotApproval[];
}

const defaultAutopilotApprovalLimit = 8;

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

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const objectField = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;

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

const autopilotApprovalForEvent = (
  run: RunRecord,
  event: RunEvent
): AutopilotApproval | undefined => {
  if (event.type !== "approval_auto_approved") {
    return undefined;
  }

  const gate = stringField(event.data?.gate) ?? stringField(event.data?.reason);
  const gateReason = stringField(event.data?.gateReason);
  const policyDecision = stringField(event.data?.policyDecision);
  const policyReason = stringField(event.data?.policyReason);
  const artifact = artifactForRef(run, event.data?.artifactRef);
  const sourceArtifact = artifactForRef(run, event.data?.sourceArtifactRef);
  const transfer = objectField(event.data?.transfer);
  const approval: AutopilotApproval = {
    runId: run.runId,
    createdAt: event.createdAt,
    updatedAt: run.updatedAt,
    repoPath: run.repoPath,
    mode: run.mode,
    state: run.state,
    goal: run.userGoal,
    message: event.message
  };

  if (gate) {
    approval.gate = gate;
  }

  if (gateReason) {
    approval.gateReason = gateReason;
  }

  if (policyDecision) {
    approval.policyDecision = policyDecision;
  }

  if (policyReason) {
    approval.policyReason = policyReason;
  }

  if (artifact) {
    approval.artifact = artifact;
  }

  if (sourceArtifact) {
    approval.sourceArtifact = sourceArtifact;
  }

  if (transfer) {
    approval.transfer = transfer;
  }

  return approval;
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
    artifactForRef(run, approvalEvent?.data?.sourceArtifactRef),
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

export const recentAutopilotApprovalsFromRuns = (
  runs: RunRecord[],
  limit = defaultAutopilotApprovalLimit
): AutopilotApproval[] =>
  runs
    .flatMap((run) =>
      run.events
        .map((event) => autopilotApprovalForEvent(run, event))
        .filter((approval): approval is AutopilotApproval => approval !== undefined)
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);

export const approvalInboxViewFromRuns = (
  runs: RunRecord[],
  limit = defaultAutopilotApprovalLimit
): ApprovalInboxView => ({
  pendingApprovals: pendingApprovalsFromRuns(runs),
  recentAutopilotApprovals: recentAutopilotApprovalsFromRuns(runs, limit)
});
