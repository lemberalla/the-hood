import { roleLaneLabel } from "./handoffs.js";
import type {
  JsonObject,
  ProgressPacketSourceRef,
  ReviewLane,
  ReviewLaneEvidence,
  ReviewLaneOwner,
  ReviewLaneState,
  RunArtifact,
  RunEvent,
  RunRecord,
  RuntimeRole,
  ToolEvent
} from "./types.js";

const eventSource = (run: RunRecord, event: RunEvent): ProgressPacketSourceRef => ({
  kind: "run_event",
  runId: run.runId,
  id: event.id,
  eventType: event.type
});

const artifactSource = (run: RunRecord, artifact: RunArtifact): ProgressPacketSourceRef => ({
  kind: "run_artifact",
  runId: run.runId,
  ref: artifact.ref
});

const toolSource = (run: RunRecord, event: ToolEvent): ProgressPacketSourceRef => ({
  kind: "tool_event",
  runId: run.runId,
  id: event.id
});

const runSource = (run: RunRecord): ProgressPacketSourceRef => ({
  kind: "run_record",
  runId: run.runId
});

const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const numberField = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const providerResponseEvents = (run: RunRecord, role: RuntimeRole): RunEvent[] =>
  run.events.filter((event) => {
    if (event.type !== "agent_response" || !event.data) {
      return false;
    }

    return event.data.role === role;
  });

const latestProviderResponseEvent = (run: RunRecord, role: RuntimeRole): RunEvent | undefined =>
  providerResponseEvents(run, role).at(-1);

const summonResponseEvents = (run: RunRecord, role: RuntimeRole): RunEvent[] =>
  run.events.filter((event) => event.type === "summon_response" && event.data?.role === role);

const latestSummonResponseEvent = (run: RunRecord, role: RuntimeRole): RunEvent | undefined =>
  summonResponseEvents(run, role).at(-1);

const artifactForEvent = (run: RunRecord, event: RunEvent | undefined): RunArtifact | undefined => {
  const artifactRef = stringField(event?.data?.artifactRef);
  return artifactRef ? run.artifacts.find((artifact) => artifact.ref === artifactRef) : undefined;
};

const readOnlyOwnerRoles = new Set<RuntimeRole>(["verifier", "qa", "critic", "planner", "researcher", "citation"]);

const roleOwner = (run: RunRecord, role: RuntimeRole): ReviewLaneOwner => {
  const assignment = run.roleMapping[role];
  const label = roleLaneLabel(role);

  if (!assignment) {
    return {
      kind: "role",
      label,
      role,
      readOnly: readOnlyOwnerRoles.has(role)
    };
  }

  return {
    kind: "role",
    label,
    role,
    readOnly: readOnlyOwnerRoles.has(role),
    provider: assignment.provider,
    model: assignment.model,
    assignment: `${assignment.provider}:${assignment.model}`
  };
};

const roleOwnerFromEvent = (
  run: RunRecord,
  role: RuntimeRole,
  event: RunEvent | undefined
): ReviewLaneOwner => {
  const owner = roleOwner(run, role);
  const provider = stringField(event?.data?.provider);
  const model = stringField(event?.data?.model);

  return provider && model
    ? {
        ...owner,
        provider,
        model,
        assignment: `${provider}:${model}`
      }
    : owner;
};

const runtimeOwner = (label: string): ReviewLaneOwner => ({
  kind: "runtime",
  label,
  readOnly: true
});

const implementationReviewRequired = (run: RunRecord): boolean =>
  run.mode === "implement" ||
  ["implementing", "verifying", "integrating"].includes(run.state) ||
  providerResponseEvents(run, "implementer").length > 0 ||
  providerResponseEvents(run, "verifier").length > 0 ||
  run.events.some((event) => event.type === "git_evidence_captured" || event.type === "validation_evidence_captured");

const verifierLaneState = (run: RunRecord, event: RunEvent | undefined): ReviewLaneState => {
  if (!event) {
    return "pending";
  }

  const status = stringField(event.data?.status);
  if (status === "failed") {
    return "failed";
  }

  if (status === "blocked") {
    return "blocked";
  }

  if (run.approvalRequired && run.approvalReason?.startsWith("Verifier returned")) {
    return "needs_revision";
  }

  return "satisfied";
};

const providerLaneState = (event: RunEvent): ReviewLaneState => {
  const status = stringField(event.data?.status);

  if (status === "failed") {
    return "failed";
  }

  if (status === "blocked") {
    return "blocked";
  }

  return "satisfied";
};

const providerLaneSourceRefs = (
  run: RunRecord,
  event: RunEvent,
  artifact: RunArtifact | undefined
): ProgressPacketSourceRef[] => [
  eventSource(run, event),
  ...(artifact ? [artifactSource(run, artifact)] : [])
];

const providerLaneSummary = (
  event: RunEvent,
  artifact: RunArtifact | undefined,
  fallback: string
): string =>
  artifact?.summary ?? event.message ?? fallback;

const summonEvidence = (run: RunRecord, role: RuntimeRole): ReviewLaneEvidence[] =>
  summonResponseEvents(run, role).slice(-3).map((event) => {
    const artifact = artifactForEvent(run, event);

    return {
      sourceKind: "summon_evidence",
      summary: providerLaneSummary(event, artifact, `Read-only ${role} summon evidence is recorded.`),
      sourceRefs: providerLaneSourceRefs(run, event, artifact),
      artifactRefs: artifact ? [artifact.ref] : [],
      eventRefs: [event.id],
      canSatisfyRequired: false
    };
  });

const verifierLane = (run: RunRecord): ReviewLane | undefined => {
  const event = latestProviderResponseEvent(run, "verifier");
  const sidecarEvidence = summonEvidence(run, "verifier");

  if (!event && !implementationReviewRequired(run) && sidecarEvidence.length === 0) {
    return undefined;
  }

  const artifact = artifactForEvent(run, event);
  const latestSummon = latestSummonResponseEvent(run, "verifier");
  const required = implementationReviewRequired(run);
  const owner = roleOwnerFromEvent(run, "verifier", event ?? (!required ? latestSummon : undefined));
  const state = event
    ? verifierLaneState(run, event)
    : latestSummon && sidecarEvidence.length > 0 && !required
      ? providerLaneState(latestSummon)
      : "pending";
  const sourceKind = event
    ? "verifier_response"
    : sidecarEvidence.length > 0 && !required
      ? "summon_evidence"
      : "required_gate";

  return {
    id: "review-lane-verifier",
    label: owner.assignment ? `${owner.label} (${owner.assignment})` : owner.label,
    kind: "reviewer",
    role: "verifier",
    state,
    required,
    sourceKind,
    summary: event
      ? providerLaneSummary(event, artifact, "Verifier review is recorded.")
      : sidecarEvidence.length > 0 && !required
        ? "Read-only verifier summon evidence is recorded; it does not replace required verification."
        : "Verifier review is required before implementation work can be accepted.",
    sourceRefs: event
      ? providerLaneSourceRefs(run, event, artifact)
      : sidecarEvidence.length > 0 && !required
        ? sidecarEvidence.flatMap((evidence) => evidence.sourceRefs)
        : [runSource(run)],
    artifactRefs: event
      ? artifact ? [artifact.ref] : []
      : sidecarEvidence.flatMap((evidence) => evidence.artifactRefs),
    eventRefs: event
      ? [event.id]
      : sidecarEvidence.flatMap((evidence) => evidence.eventRefs),
    owner,
    canSatisfyRequired: Boolean(event),
    satisfiesRequired: required && state === "satisfied" && Boolean(event),
    sidecarEvidence
  };
};

const criticLane = (run: RunRecord): ReviewLane | undefined => {
  const event = latestProviderResponseEvent(run, "critic");
  const sidecarEvidence = summonEvidence(run, "critic");
  if (!event && sidecarEvidence.length === 0) {
    return undefined;
  }

  const artifact = artifactForEvent(run, event);
  const latestSummon = latestSummonResponseEvent(run, "critic");
  const owner = roleOwnerFromEvent(run, "critic", event ?? latestSummon);
  const state = event
    ? providerLaneState(event)
    : latestSummon
      ? providerLaneState(latestSummon)
      : "pending";

  return {
    id: "review-lane-critic",
    label: owner.assignment ? `${owner.label} (${owner.assignment})` : owner.label,
    kind: "critic",
    role: "critic",
    state,
    required: false,
    sourceKind: event ? "critic_response" : "summon_evidence",
    summary: event
      ? providerLaneSummary(event, artifact, "Critic review is recorded.")
      : "Read-only critic summon evidence is recorded.",
    sourceRefs: event
      ? providerLaneSourceRefs(run, event, artifact)
      : sidecarEvidence.flatMap((evidence) => evidence.sourceRefs),
    artifactRefs: event
      ? artifact ? [artifact.ref] : []
      : sidecarEvidence.flatMap((evidence) => evidence.artifactRefs),
    eventRefs: event
      ? [event.id]
      : sidecarEvidence.flatMap((evidence) => evidence.eventRefs),
    owner,
    canSatisfyRequired: false,
    satisfiesRequired: false,
    sidecarEvidence
  };
};

const validationArtifacts = (run: RunRecord): RunArtifact[] =>
  run.artifacts.filter((artifact) => artifact.summary.includes("Validation summary"));

const validationEvents = (run: RunRecord): RunEvent[] =>
  run.events.filter((event) => event.type === "validation_evidence_captured");

const validationToolEvents = (run: RunRecord): ToolEvent[] =>
  run.toolEvents.filter((event) => event.tool.startsWith("validation_"));

const validationFailureCount = (events: RunEvent[], toolEvents: ToolEvent[]): number => {
  const latestEventData = events.at(-1)?.data;
  const recordedFailureCount = isJsonObject(latestEventData)
    ? numberField(latestEventData.failedCommandCount)
    : undefined;

  return recordedFailureCount ?? toolEvents.filter((event) => event.exitCode !== 0).length;
};

const qaLane = (run: RunRecord): ReviewLane | undefined => {
  const artifacts = validationArtifacts(run);
  const events = validationEvents(run);
  const toolEvents = validationToolEvents(run);
  const sidecarEvidence = summonEvidence(run, "qa");
  const required = implementationReviewRequired(run);
  const hasValidationEvidence = artifacts.length > 0 || events.length > 0 || toolEvents.length > 0;

  if (!required && !hasValidationEvidence) {
    return undefined;
  }

  const failures = validationFailureCount(events, toolEvents);
  const state: ReviewLaneState = hasValidationEvidence
    ? failures > 0 ? "needs_revision" : "satisfied"
    : "pending";
  const latestArtifact = artifacts.at(-1);
  const latestEvent = events.at(-1);
  const latestToolEvents = toolEvents.slice(-3);
  const sourceRefs = [
    ...(latestArtifact ? [artifactSource(run, latestArtifact)] : []),
    ...(latestEvent ? [eventSource(run, latestEvent)] : []),
    ...latestToolEvents.map((event) => toolSource(run, event)),
    ...(!hasValidationEvidence ? sidecarEvidence.flatMap((evidence) => evidence.sourceRefs) : [])
  ];
  const executedCount = latestEvent && isJsonObject(latestEvent.data)
    ? numberField(latestEvent.data.executedCommandCount) ?? toolEvents.length
    : toolEvents.length;
  const summary = hasValidationEvidence
    ? `Runtime validation captured ${executedCount} command(s), ${failures} failed.`
    : sidecarEvidence.length > 0
      ? "Runtime validation evidence is still missing; QA tester sidecar evidence is advisory."
      : "Runtime validation evidence is required for QA ownership.";

  return {
    id: "review-lane-qa",
    label: "Runtime QA / Validation",
    kind: "qa",
    state,
    required,
    sourceKind: hasValidationEvidence ? "validation_evidence" : "required_gate",
    summary,
    sourceRefs,
    artifactRefs: latestArtifact ? [latestArtifact.ref] : [],
    eventRefs: [
      ...(latestEvent ? [latestEvent.id] : []),
      ...latestToolEvents.map((event) => event.id),
      ...(!hasValidationEvidence ? sidecarEvidence.flatMap((evidence) => evidence.eventRefs) : [])
    ],
    owner: runtimeOwner("Runtime QA / Validation"),
    canSatisfyRequired: hasValidationEvidence,
    satisfiesRequired: required && hasValidationEvidence && state === "satisfied",
    sidecarEvidence
  };
};

const qaTesterLane = (run: RunRecord): ReviewLane | undefined => {
  const event = latestProviderResponseEvent(run, "qa");
  const sidecarEvidence = summonEvidence(run, "qa");
  if (!event && sidecarEvidence.length === 0) {
    return undefined;
  }

  const artifact = artifactForEvent(run, event);
  const latestSummon = latestSummonResponseEvent(run, "qa");
  const owner = roleOwnerFromEvent(run, "qa", event ?? latestSummon);
  const state = event
    ? providerLaneState(event)
    : latestSummon
      ? providerLaneState(latestSummon)
      : "pending";

  return {
    id: "review-lane-qa-tester",
    label: owner.assignment ? `${owner.label} (${owner.assignment})` : owner.label,
    kind: "tester",
    role: "qa",
    state,
    required: false,
    sourceKind: event ? "qa_response" : "summon_evidence",
    summary: event
      ? providerLaneSummary(event, artifact, "QA tester response is recorded.")
      : "Read-only QA tester summon evidence is recorded; runtime validation remains the proof.",
    sourceRefs: event
      ? providerLaneSourceRefs(run, event, artifact)
      : sidecarEvidence.flatMap((evidence) => evidence.sourceRefs),
    artifactRefs: event
      ? artifact ? [artifact.ref] : []
      : sidecarEvidence.flatMap((evidence) => evidence.artifactRefs),
    eventRefs: event
      ? [event.id]
      : sidecarEvidence.flatMap((evidence) => evidence.eventRefs),
    owner,
    canSatisfyRequired: false,
    satisfiesRequired: false,
    sidecarEvidence
  };
};

export const deriveReviewLanes = (run: RunRecord): ReviewLane[] =>
  [verifierLane(run), qaLane(run), qaTesterLane(run), criticLane(run)].filter(
    (lane): lane is ReviewLane => Boolean(lane)
  );
