import { roleLaneLabel } from "./handoffs.js";
import type {
  JsonObject,
  ProgressPacketSourceRef,
  ReviewLane,
  ReviewLaneState,
  RoleAssignment,
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

const artifactForEvent = (run: RunRecord, event: RunEvent | undefined): RunArtifact | undefined => {
  const artifactRef = stringField(event?.data?.artifactRef);
  return artifactRef ? run.artifacts.find((artifact) => artifact.ref === artifactRef) : undefined;
};

const assignmentLabel = (assignment: RoleAssignment | undefined): string | undefined =>
  assignment ? `${assignment.provider}:${assignment.model}` : undefined;

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

const verifierLane = (run: RunRecord): ReviewLane | undefined => {
  const event = latestProviderResponseEvent(run, "verifier");

  if (!event && !implementationReviewRequired(run)) {
    return undefined;
  }

  const artifact = artifactForEvent(run, event);
  const assignment = assignmentLabel(run.roleMapping.verifier);
  const label = assignment ? `${roleLaneLabel("verifier")} (${assignment})` : roleLaneLabel("verifier");

  return {
    id: "review-lane-verifier",
    label,
    kind: "reviewer",
    role: "verifier",
    state: verifierLaneState(run, event),
    required: true,
    sourceKind: event ? "verifier_response" : "required_gate",
    summary: event
      ? providerLaneSummary(event, artifact, "Verifier review is recorded.")
      : "Verifier review is required before implementation work can be accepted.",
    sourceRefs: event ? providerLaneSourceRefs(run, event, artifact) : [runSource(run)],
    artifactRefs: artifact ? [artifact.ref] : [],
    eventRefs: event ? [event.id] : []
  };
};

const criticLane = (run: RunRecord): ReviewLane | undefined => {
  const event = latestProviderResponseEvent(run, "critic");
  if (!event) {
    return undefined;
  }

  const artifact = artifactForEvent(run, event);
  const assignment = assignmentLabel(run.roleMapping.critic);
  const label = assignment ? `${roleLaneLabel("critic")} (${assignment})` : roleLaneLabel("critic");

  return {
    id: "review-lane-critic",
    label,
    kind: "critic",
    role: "critic",
    state: providerLaneState(event),
    required: false,
    sourceKind: "critic_response",
    summary: providerLaneSummary(event, artifact, "Critic review is recorded."),
    sourceRefs: providerLaneSourceRefs(run, event, artifact),
    artifactRefs: artifact ? [artifact.ref] : [],
    eventRefs: [event.id]
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

  if (artifacts.length === 0 && events.length === 0 && toolEvents.length === 0) {
    return undefined;
  }

  const failures = validationFailureCount(events, toolEvents);
  const latestArtifact = artifacts.at(-1);
  const latestEvent = events.at(-1);
  const latestToolEvents = toolEvents.slice(-3);
  const sourceRefs = [
    ...(latestArtifact ? [artifactSource(run, latestArtifact)] : []),
    ...(latestEvent ? [eventSource(run, latestEvent)] : []),
    ...latestToolEvents.map((event) => toolSource(run, event))
  ];
  const executedCount = latestEvent && isJsonObject(latestEvent.data)
    ? numberField(latestEvent.data.executedCommandCount) ?? toolEvents.length
    : toolEvents.length;

  return {
    id: "review-lane-qa",
    label: "Runtime QA / Validation",
    kind: "qa",
    state: failures > 0 ? "needs_revision" : "satisfied",
    required: true,
    sourceKind: "validation_evidence",
    summary: `Runtime validation captured ${executedCount} command(s), ${failures} failed.`,
    sourceRefs,
    artifactRefs: latestArtifact ? [latestArtifact.ref] : [],
    eventRefs: [
      ...(latestEvent ? [latestEvent.id] : []),
      ...latestToolEvents.map((event) => event.id)
    ]
  };
};

export const deriveReviewLanes = (run: RunRecord): ReviewLane[] =>
  [verifierLane(run), qaLane(run), criticLane(run)].filter(
    (lane): lane is ReviewLane => Boolean(lane)
  );
