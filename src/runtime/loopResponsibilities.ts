import { roleLaneLabel } from "./handoffs.js";
import { nowIso } from "./ids.js";
import { deriveReviewLanes } from "./reviewLanes.js";
import {
  runtimeRoles,
  type LoopResponsibility,
  type LoopResponsibilityKind,
  type LoopResponsibilityOwner,
  type LoopResponsibilitySchedule,
  type LoopResponsibilityStatus,
  type ReviewLane,
  type ReviewLaneState,
  type RunArtifact,
  type RunEvent,
  type RunHandoffEvent,
  type RunRecord,
  type RuntimeRole
} from "./types.js";

const readOnlyRoles = new Set<RuntimeRole>(["orchestrator", "planner", "researcher", "qa", "verifier", "critic", "citation"]);
const providerResponseEventTypes = new Set(["agent_response", "reconciliation_response", "summon_response"]);

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const roleField = (value: unknown): RuntimeRole | undefined => {
  const role = stringField(value);

  return runtimeRoles.find((candidate) => candidate === role);
};

const unique = (values: Array<string | undefined>): string[] =>
  [...new Set(values.filter((value): value is string => Boolean(value)))];

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

const latestHandoff = (
  run: RunRecord,
  predicate: (handoff: RunHandoffEvent) => boolean
): RunHandoffEvent | undefined =>
  run.handoffs.filter(predicate).at(-1);

const eventIsAfter = (left: RunEvent | undefined, right: RunEvent | undefined): boolean =>
  Boolean(left && (!right || left.createdAt > right.createdAt));

const providerResponseEvents = (run: RunRecord, role: RuntimeRole): RunEvent[] =>
  run.events.filter((event) => event.type === "agent_response" && event.data?.role === role);

const latestProviderResponseEvent = (run: RunRecord, role: RuntimeRole): RunEvent | undefined =>
  providerResponseEvents(run, role).at(-1);

const latestSummonResponseEvent = (run: RunRecord, role: RuntimeRole): RunEvent | undefined =>
  run.events.filter((event) => event.type === "summon_response" && event.data?.role === role).at(-1);

const latestProviderWaitEvent = (run: RunRecord): RunEvent | undefined => {
  const directive = latestEvent(run, (event) => event.type === "agent_directive_created");
  const response = latestEvent(run, (event) => providerResponseEventTypes.has(event.type));

  return eventIsAfter(directive, response) ? directive : undefined;
};

const eventArtifactRefs = (event: RunEvent | undefined): string[] =>
  unique([stringField(event?.data?.artifactRef), stringField(event?.data?.sourceArtifactRef)]);

const roleOwner = (run: RunRecord, role: RuntimeRole, event?: RunEvent): LoopResponsibilityOwner => {
  const configured = run.roleMapping[role];
  const provider = stringField(event?.data?.provider) ?? configured?.provider;
  const model = stringField(event?.data?.model) ?? configured?.model;

  return {
    kind: "role",
    label: roleLaneLabel(role),
    role,
    readOnly: readOnlyRoles.has(role),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(provider && model ? { assignment: `${provider}:${model}` } : {})
  };
};

const runtimeOwner = (label: string): LoopResponsibilityOwner => ({
  kind: "runtime",
  label,
  readOnly: true
});

const providerStatus = (event: RunEvent | undefined): string | undefined =>
  stringField(event?.data?.status);

const providerSummary = (event: RunEvent | undefined, fallback: string): string =>
  event?.message ?? fallback;

const providerResponsibilityStatus = (
  event: RunEvent | undefined,
  activeStatus: LoopResponsibilityStatus
): LoopResponsibilityStatus => {
  const status = providerStatus(event);

  if (status === "blocked" || status === "failed") {
    return "blocked";
  }

  if (status === "ok") {
    return "satisfied";
  }

  return activeStatus;
};

const reviewStatus = (state: ReviewLaneState): LoopResponsibilityStatus => {
  switch (state) {
    case "satisfied":
      return "satisfied";
    case "blocked":
    case "failed":
    case "needs_revision":
      return "blocked";
    case "pending":
      return "pending";
  }
};

const readOnlyRoleForRun = (run: RunRecord): RuntimeRole => {
  if (run.preferredRole && run.roleMapping[run.preferredRole]) {
    return run.preferredRole;
  }

  if (run.mode === "review" && run.roleMapping.critic) {
    return "critic";
  }

  if (run.mode === "research" && run.roleMapping.researcher) {
    return "researcher";
  }

  if (run.mode === "plan" && run.roleMapping.planner) {
    return "planner";
  }

  return "orchestrator";
};

const implementationEvidenceExists = (run: RunRecord): boolean =>
  providerResponseEvents(run, "implementer").length > 0 ||
  run.events.some((event) =>
    [
      "git_evidence_captured",
      "validation_evidence_captured",
      "integration_patch_prepared",
      "patch_applied",
      "integration_report_written"
    ].includes(event.type)
  );

const implementationApplicable = (run: RunRecord): boolean =>
  run.mode === "implement" ||
  ["implementing", "verifying", "integrating"].includes(run.state) ||
  implementationEvidenceExists(run);

const reviewLane = (lanes: ReviewLane[], role: RuntimeRole): ReviewLane | undefined =>
  lanes.find((lane) => lane.role === role);

const qaLane = (lanes: ReviewLane[]): ReviewLane | undefined =>
  lanes.find((lane) => lane.kind === "qa");

const qaTesterLane = (lanes: ReviewLane[]): ReviewLane | undefined =>
  lanes.find((lane) => lane.kind === "tester" && lane.role === "qa");

const responsibility = (
  run: RunRecord,
  input: {
    kind: LoopResponsibilityKind;
    label: string;
    owner: LoopResponsibilityOwner;
    required: boolean;
    status: LoopResponsibilityStatus;
    reason: string;
    canSatisfyGate?: boolean;
    artifactRefs?: string[];
    eventRefs?: string[];
    handoffRefs?: string[];
    sidecarOnly?: boolean;
    blocking?: boolean;
  }
): LoopResponsibility => {
  const blocking = input.blocking ?? (
    input.required && (input.status === "blocked" || input.status === "pending" || input.status === "in_progress")
  );

  return {
    id: `loop-responsibility-${input.kind}`,
    kind: input.kind,
    label: input.label,
    owner: input.owner,
    required: input.required,
    blocking,
    status: input.status,
    state: run.state,
    reason: input.reason,
    canSatisfyGate: input.canSatisfyGate ?? false,
    artifactRefs: unique(input.artifactRefs ?? []),
    eventRefs: unique(input.eventRefs ?? []),
    handoffRefs: unique(input.handoffRefs ?? []),
    ...(input.sidecarOnly ? { sidecarOnly: true } : {})
  };
};

const planningResponsibility = (run: RunRecord, waitingDirective: RunEvent | undefined): LoopResponsibility => {
  const role = readOnlyRoleForRun(run);
  const event = latestProviderResponseEvent(run, role) ?? (role !== "orchestrator" ? latestProviderResponseEvent(run, "orchestrator") : undefined);
  const activeStatus: LoopResponsibilityStatus =
    waitingDirective && roleField(waitingDirective.data?.role) === role
      ? "in_progress"
      : run.state === "created"
        ? "ready"
        : "pending";
  const status = providerStatus(event)
    ? providerResponsibilityStatus(event, activeStatus)
    : activeStatus;
  const handoff = latestHandoff(run, (candidate) => candidate.toRole === role);

  return responsibility(run, {
    kind: "plan",
    label: "Plan / Orchestrate",
    owner: roleOwner(run, role, event ?? waitingDirective),
    required: true,
    status,
    reason: event ? providerSummary(event, "Planner or orchestrator response is recorded.") : "Runtime is waiting for a schema-bound plan or orchestration decision.",
    artifactRefs: eventArtifactRefs(event ?? waitingDirective),
    eventRefs: unique([event?.id, waitingDirective?.id]),
    handoffRefs: unique([handoff?.id])
  });
};

const implementationResponsibility = (run: RunRecord, waitingDirective: RunEvent | undefined): LoopResponsibility => {
  const event = latestProviderResponseEvent(run, "implementer");
  const applicable = implementationApplicable(run);
  const waitingForImplementer = waitingDirective && roleField(waitingDirective.data?.role) === "implementer";
  const activeStatus: LoopResponsibilityStatus =
    waitingForImplementer || run.state === "implementing"
      ? "in_progress"
      : applicable
        ? "pending"
        : "skipped";
  const status = waitingForImplementer || run.state === "implementing"
    ? "in_progress"
    : event
    ? providerResponsibilityStatus(event, activeStatus)
    : activeStatus;
  const handoff = latestHandoff(run, (candidate) => candidate.toRole === "implementer");

  return responsibility(run, {
    kind: "implement",
    label: "Implement",
    owner: roleOwner(run, "implementer", event ?? waitingDirective),
    required: applicable,
    status,
    reason: event
      ? providerSummary(event, "Implementer response is recorded.")
      : applicable
        ? "Implementation responsibility is pending or in progress under the runtime loop."
        : "No implementation responsibility is active for this run.",
    artifactRefs: eventArtifactRefs(event ?? waitingDirective),
    eventRefs: unique([event?.id, waitingForImplementer ? waitingDirective?.id : undefined]),
    handoffRefs: unique([handoff?.id])
  });
};

const verifierResponsibility = (run: RunRecord, lanes: ReviewLane[]): LoopResponsibility => {
  const lane = reviewLane(lanes, "verifier");
  const applicable = implementationApplicable(run) || Boolean(lane);

  return responsibility(run, {
    kind: "verify",
    label: "Verifier Review",
    owner: lane?.owner ?? roleOwner(run, "verifier"),
    required: lane?.required ?? applicable,
    status: lane ? reviewStatus(lane.state) : applicable ? "pending" : "skipped",
    reason: lane?.summary ?? (applicable
      ? "Verifier review is required before implementation work can be accepted."
      : "No verifier responsibility is active for this run."),
    canSatisfyGate: lane?.canSatisfyRequired ?? false,
    artifactRefs: lane?.artifactRefs ?? [],
    eventRefs: lane?.eventRefs ?? [],
    sidecarOnly: lane?.sourceKind === "summon_evidence"
  });
};

const qaResponsibility = (run: RunRecord, lanes: ReviewLane[]): LoopResponsibility => {
  const lane = qaLane(lanes);
  const applicable = implementationApplicable(run) || Boolean(lane);

  return responsibility(run, {
    kind: "qa",
    label: "Runtime QA / Validation",
    owner: lane?.owner ?? runtimeOwner("Runtime QA / Validation"),
    required: lane?.required ?? applicable,
    status: lane ? reviewStatus(lane.state) : applicable ? "pending" : "skipped",
    reason: lane?.summary ?? (applicable
      ? "Runtime validation evidence is required for QA ownership."
      : "No runtime validation responsibility is active for this run."),
    canSatisfyGate: lane?.canSatisfyRequired ?? false,
    artifactRefs: lane?.artifactRefs ?? [],
    eventRefs: lane?.eventRefs ?? []
  });
};

const qaTesterResponsibility = (run: RunRecord, lanes: ReviewLane[], waitingDirective: RunEvent | undefined): LoopResponsibility => {
  const lane = qaTesterLane(lanes);
  const event = latestProviderResponseEvent(run, "qa");
  const summon = latestSummonResponseEvent(run, "qa");
  const waitingForQa = waitingDirective && roleField(waitingDirective.data?.role) === "qa";
  const applicable = implementationApplicable(run) || Boolean(lane);
  const status: LoopResponsibilityStatus = lane
    ? reviewStatus(lane.state)
    : waitingForQa
      ? "in_progress"
      : applicable
        ? "ready"
        : "skipped";

  return responsibility(run, {
    kind: "test",
    label: "QA Tester",
    owner: lane?.owner ?? roleOwner(run, "qa", event ?? summon ?? waitingDirective),
    required: false,
    status,
    reason: lane?.summary ?? (applicable
      ? "Model-assisted QA can review evidence and suggest tests, but runtime validation remains the proof."
      : "No model-assisted QA tester responsibility is active for this run."),
    artifactRefs: lane?.artifactRefs ?? eventArtifactRefs(event ?? summon ?? waitingDirective),
    eventRefs: lane?.eventRefs ?? unique([event?.id, summon?.id, waitingForQa ? waitingDirective?.id : undefined]),
    sidecarOnly: lane?.sourceKind === "summon_evidence",
    blocking: false
  });
};

const criticResponsibility = (run: RunRecord, lanes: ReviewLane[], waitingDirective: RunEvent | undefined): LoopResponsibility => {
  const lane = reviewLane(lanes, "critic");
  const event = latestProviderResponseEvent(run, "critic");
  const summon = latestSummonResponseEvent(run, "critic");
  const waitingForCritic = waitingDirective && roleField(waitingDirective.data?.role) === "critic";
  const status: LoopResponsibilityStatus = lane
    ? reviewStatus(lane.state)
    : waitingForCritic || run.state === "critiquing"
      ? "in_progress"
      : "advisory";

  return responsibility(run, {
    kind: "critique",
    label: "Critic / Challenge",
    owner: lane?.owner ?? roleOwner(run, "critic", event ?? summon ?? waitingDirective),
    required: false,
    status,
    reason: lane?.summary ?? "Critic responsibility is advisory unless the runtime explicitly schedules it.",
    artifactRefs: lane?.artifactRefs ?? eventArtifactRefs(event ?? summon ?? waitingDirective),
    eventRefs: lane?.eventRefs ?? unique([event?.id, summon?.id, waitingForCritic ? waitingDirective?.id : undefined]),
    sidecarOnly: lane?.sourceKind === "summon_evidence",
    blocking: false
  });
};

const integrationResponsibility = (run: RunRecord): LoopResponsibility => {
  const integrationEvent = latestEvent(run, (event) => event.type === "integration_report_written" || event.type === "patch_applied");
  const patchPrepared = latestEvent(run, (event) => event.type === "integration_patch_prepared");
  const applicable = run.mode === "implement" || Boolean(integrationEvent ?? patchPrepared) || run.state === "integrating";
  const blockedForApproval = run.approvalRequired && Boolean(run.approvalReason?.includes("apply isolated patch"));
  const status: LoopResponsibilityStatus = integrationEvent || (run.mode === "implement" && run.state === "completed")
    ? "satisfied"
    : blockedForApproval
      ? "blocked"
      : run.state === "integrating"
        ? "in_progress"
        : applicable
          ? "pending"
          : "skipped";

  return responsibility(run, {
    kind: "integrate",
    label: "Runtime Integration",
    owner: runtimeOwner("Runtime Integrator"),
    required: applicable,
    status,
    reason: integrationEvent
      ? integrationEvent.message
      : blockedForApproval
        ? run.approvalReason ?? "Runtime integration is waiting for approval."
        : applicable
          ? "Runtime integration applies only approved isolated patches."
          : "No integration responsibility is active for this run.",
    canSatisfyGate: Boolean(integrationEvent),
    eventRefs: unique([integrationEvent?.id, patchPrepared?.id]),
    artifactRefs: eventArtifactRefs(integrationEvent ?? patchPrepared)
  });
};

const reconciliationResponsibility = (run: RunRecord): LoopResponsibility => {
  const reconciliationEvent = latestEvent(run, (event) => event.type === "reconciliation_response");
  const reconciliationArtifact = latestArtifact(run, (artifact) => artifact.kind === "reconciliation");
  const progressArtifact = latestArtifact(run, (artifact) => artifact.kind === "progress");
  const status: LoopResponsibilityStatus = reconciliationEvent || reconciliationArtifact
    ? "satisfied"
    : run.state === "completed" && progressArtifact
      ? "ready"
      : "skipped";

  return responsibility(run, {
    kind: "reconcile",
    label: "Planner Reconciliation",
    owner: runtimeOwner("Runtime Reconciliation"),
    required: false,
    status,
    reason: reconciliationEvent
      ? reconciliationEvent.message
      : status === "ready"
        ? "Completed run has a progress packet ready for planner reconciliation."
        : "Planner reconciliation is available after a completed run writes a progress packet.",
    artifactRefs: unique([reconciliationArtifact?.ref, progressArtifact?.ref]),
    eventRefs: reconciliationEvent ? [reconciliationEvent.id] : [],
    blocking: false
  });
};

const approvalResponsibility = (run: RunRecord): LoopResponsibility => {
  const approvalEvent = run.approvalEvents.at(-1);
  const required = run.approvalRequired;
  const latestApprovalGate = latestEvent(run, (event) => event.type === "approval_required");
  const handoff = latestHandoff(run, (candidate) =>
    candidate.kind === "approval_gate" || candidate.kind === "approval_auto_approved"
  );
  const status: LoopResponsibilityStatus = required
    ? "blocked"
    : approvalEvent
      ? "satisfied"
      : "skipped";

  return responsibility(run, {
    kind: "operator_approval",
    label: "Operator Approval",
    owner: runtimeOwner("Runtime Approval Gate"),
    required,
    status,
    reason: required
      ? run.approvalReason ?? "Runtime is waiting for operator approval."
      : approvalEvent
        ? approvalEvent.reason
        : "No operator approval gate is active.",
    canSatisfyGate: Boolean(approvalEvent && !required),
    artifactRefs: eventArtifactRefs(latestApprovalGate),
    eventRefs: latestApprovalGate ? [latestApprovalGate.id] : [],
    handoffRefs: unique([handoff?.id]),
    blocking: required
  });
};

const completionResponsibility = (run: RunRecord): LoopResponsibility => {
  const completed = run.state === "completed";
  const terminalFailure = run.state === "failed" || run.state === "aborted";
  const finalReport = latestArtifact(run, (artifact) => artifact.kind === "report" && artifact.summary.includes("Final report"));
  const completedEvent = latestEvent(run, (event) => event.type === "run_completed" || event.type === "run_failed" || event.type === "run_aborted");
  const status: LoopResponsibilityStatus = completed
    ? "satisfied"
    : terminalFailure
      ? "blocked"
      : "pending";

  return responsibility(run, {
    kind: "complete",
    label: "Completion",
    owner: runtimeOwner("Runtime Completion"),
    required: true,
    status,
    reason: run.stopReason ?? (completed
      ? "Run completed."
      : terminalFailure
        ? `Run is ${run.state}.`
        : "Run has not reached a terminal success state."),
    canSatisfyGate: completed,
    artifactRefs: finalReport ? [finalReport.ref] : [],
    eventRefs: completedEvent ? [completedEvent.id] : [],
    blocking: terminalFailure
  });
};

export const deriveLoopResponsibilitySchedule = (run: RunRecord): LoopResponsibilitySchedule => {
  const waitingDirective = latestProviderWaitEvent(run);
  const lanes = deriveReviewLanes(run);
  const responsibilities = [
    planningResponsibility(run, waitingDirective),
    implementationResponsibility(run, waitingDirective),
    qaResponsibility(run, lanes),
    qaTesterResponsibility(run, lanes, waitingDirective),
    verifierResponsibility(run, lanes),
    criticResponsibility(run, lanes, waitingDirective),
    integrationResponsibility(run),
    reconciliationResponsibility(run),
    approvalResponsibility(run),
    completionResponsibility(run)
  ];

  return {
    schemaVersion: 1,
    kind: "loop_responsibility_schedule",
    runId: run.runId,
    generatedAt: nowIso(),
    phase: run.state,
    responsibilities,
    blockers: responsibilities.filter((item) => item.blocking)
  };
};
