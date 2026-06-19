import { deriveOperatorNextActions } from "./operatorNextActions.js";
import { deriveLoopResponsibilitySchedule } from "./loopResponsibilities.js";
import { deriveReviewLanes } from "./reviewLanes.js";
import type { LoopResponsibility, OperatorNextAction, ReviewLane, RunArtifact, RunEvent, RunRecord } from "./types.js";

export type RunMonitorPhase =
  | "provider_wait"
  | "approval_gate"
  | "transfer_gate"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export interface RunMonitorReviewLane {
  id: string;
  label: string;
  kind: ReviewLane["kind"];
  state: ReviewLane["state"];
  required: boolean;
  summary: string;
  owner: ReviewLane["owner"];
  canSatisfyRequired: boolean;
  satisfiesRequired: boolean;
  sidecarEvidenceCount: number;
}

export interface RunMonitorItem {
  runId: string;
  updatedAt: string;
  mode: RunRecord["mode"];
  state: RunRecord["state"];
  phase: RunMonitorPhase;
  goal: string;
  detail: string;
  lane?: string;
  provider?: string;
  gate?: string;
  artifactRefs: string[];
  reviewLanes: RunMonitorReviewLane[];
  loopResponsibilities: LoopResponsibility[];
  operatorNextActions: OperatorNextAction[];
}

const providerResponseEventTypes = new Set(["agent_response", "reconciliation_response", "summon_response"]);
const terminalStates = new Set(["completed", "failed", "aborted"]);

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const latestEvent = (
  run: RunRecord,
  predicate: (event: RunEvent) => boolean
): RunEvent | undefined =>
  run.events.filter(predicate).at(-1);

const latestArtifact = (
  run: RunRecord,
  predicate: (artifact: RunArtifact) => boolean
): RunArtifact | undefined =>
  run.artifacts.filter(predicate).at(-1);

const eventIsAfter = (left: RunEvent | undefined, right: RunEvent | undefined): boolean =>
  Boolean(left && (!right || left.createdAt > right.createdAt));

const formatProvider = (event: RunEvent | undefined): string | undefined => {
  const provider = stringField(event?.data?.provider);
  const model = stringField(event?.data?.model);

  return provider && model ? `${provider}:${model}` : undefined;
};

const directiveWait = (run: RunRecord): RunEvent | undefined => {
  const directive = latestEvent(run, (event) => event.type === "agent_directive_created");
  const response = latestEvent(run, (event) => providerResponseEventTypes.has(event.type));

  return eventIsAfter(directive, response) ? directive : undefined;
};

const latestApprovalRequiredEvent = (run: RunRecord): RunEvent | undefined =>
  latestEvent(run, (event) => event.type === "approval_required");

const approvalGateName = (run: RunRecord): string | undefined =>
  stringField(latestApprovalRequiredEvent(run)?.data?.reason) ??
  run.handoffs.filter((handoff) => handoff.kind === "approval_gate").at(-1)?.gate;

const approvalArtifactRefs = (run: RunRecord): string[] => {
  const event = latestApprovalRequiredEvent(run);
  const refs = [stringField(event?.data?.artifactRef), stringField(event?.data?.sourceArtifactRef)]
    .filter((ref): ref is string => Boolean(ref));

  return [...new Set(refs)];
};

const isTransferGate = (run: RunRecord): boolean => {
  const reason = approvalGateName(run) ?? "";
  const latestApprovalArtifactRefs = approvalArtifactRefs(run);

  return (
    reason.includes("external_transfer") ||
    run.approvalReason?.includes("transfer manifest") === true ||
    latestApprovalArtifactRefs.some((ref) =>
      run.artifacts.some((artifact) => artifact.kind === "transfer_manifest" && artifact.ref === ref)
    )
  );
};

const reviewLanes = (run: RunRecord): RunMonitorReviewLane[] =>
  deriveReviewLanes(run).map((lane) => ({
    id: lane.id,
    label: lane.label,
    kind: lane.kind,
    state: lane.state,
    required: lane.required,
    summary: lane.summary,
    owner: lane.owner,
    canSatisfyRequired: lane.canSatisfyRequired,
    satisfiesRequired: lane.satisfiesRequired,
    sidecarEvidenceCount: lane.sidecarEvidence.length
  }));

const operatorNextActions = (run: RunRecord): OperatorNextAction[] =>
  deriveOperatorNextActions(run).slice(0, 3);

const loopResponsibilities = (run: RunRecord): LoopResponsibility[] =>
  deriveLoopResponsibilitySchedule(run).responsibilities.slice(0, 10);

const monitorItemForRun = (run: RunRecord): RunMonitorItem => {
  const waitingDirective = directiveWait(run);
  const latestTransferManifest = latestArtifact(run, (artifact) => artifact.kind === "transfer_manifest");
  const gate = approvalGateName(run);

  if (run.approvalRequired) {
    const transferGate = isTransferGate(run);

    return {
      runId: run.runId,
      updatedAt: run.updatedAt,
      mode: run.mode,
      state: run.state,
      phase: transferGate ? "transfer_gate" : "approval_gate",
      goal: run.userGoal,
      detail: run.approvalReason ?? "Approval is required before this run can continue.",
      ...(gate ? { gate } : {}),
      artifactRefs: approvalArtifactRefs(run),
      reviewLanes: reviewLanes(run),
      loopResponsibilities: loopResponsibilities(run),
      operatorNextActions: operatorNextActions(run)
    };
  }

  if (waitingDirective) {
    const role = stringField(waitingDirective.data?.role);
    const provider = formatProvider(waitingDirective);
    const artifactRef = stringField(waitingDirective.data?.artifactRef);

    return {
      runId: run.runId,
      updatedAt: run.updatedAt,
      mode: run.mode,
      state: run.state,
      phase: "provider_wait",
      goal: run.userGoal,
      detail: `Waiting on ${role ?? "provider"} response since ${waitingDirective.createdAt}.`,
      ...(role ? { lane: role } : {}),
      ...(provider ? { provider } : {}),
      artifactRefs: artifactRef ? [artifactRef] : [],
      reviewLanes: reviewLanes(run),
      loopResponsibilities: loopResponsibilities(run),
      operatorNextActions: operatorNextActions(run)
    };
  }

  if (run.state === "completed" || run.state === "failed" || run.state === "aborted") {
    return {
      runId: run.runId,
      updatedAt: run.updatedAt,
      mode: run.mode,
      state: run.state,
      phase: run.state,
      goal: run.userGoal,
      detail: run.stopReason ?? `Run is ${run.state}.`,
      artifactRefs: latestTransferManifest ? [latestTransferManifest.ref] : [],
      reviewLanes: reviewLanes(run),
      loopResponsibilities: loopResponsibilities(run),
      operatorNextActions: operatorNextActions(run)
    };
  }

  return {
    runId: run.runId,
    updatedAt: run.updatedAt,
    mode: run.mode,
    state: run.state,
    phase: "running",
    goal: run.userGoal,
    detail: `Runtime is in ${run.state}.`,
    artifactRefs: latestTransferManifest ? [latestTransferManifest.ref] : [],
    reviewLanes: reviewLanes(run),
    loopResponsibilities: loopResponsibilities(run),
    operatorNextActions: operatorNextActions(run)
  };
};

export const runMonitorFromRuns = (runs: RunRecord[], limit = 6): RunMonitorItem[] =>
  runs
    .map(monitorItemForRun)
    .sort((left, right) => {
      const leftTerminal = terminalStates.has(left.state);
      const rightTerminal = terminalStates.has(right.state);

      if (leftTerminal !== rightTerminal) {
        return leftTerminal ? 1 : -1;
      }

      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, limit);
