import { nowIso } from "./ids.js";
import { deriveLoopResponsibilitySchedule } from "./loopResponsibilities.js";
import { deriveReviewLanes } from "./reviewLanes.js";
import type {
  CrewLane,
  CrewLaneAuthority,
  CrewLaneSourceKind,
  CrewLaneTrail,
  LoopResponsibility,
  ProgressPacketSourceRef,
  ReviewLane,
  RunRecord
} from "./types.js";

const readonlyRoleKinds = new Set<LoopResponsibility["kind"]>([
  "plan",
  "test",
  "verify",
  "critique",
  "reconcile"
]);

const unique = <T>(values: T[], key: (value: T) => string): T[] => {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const value of values) {
    const id = key(value);
    if (!seen.has(id)) {
      seen.add(id);
      result.push(value);
    }
  }

  return result;
};

const uniqueStrings = (values: string[]): string[] =>
  [...new Set(values.filter((value) => value.trim().length > 0))];

const sourceKey = (source: ProgressPacketSourceRef): string =>
  [source.kind, source.runId, source.id ?? "", source.ref ?? "", source.eventType ?? ""].join(":");

const sourceRefsForResponsibility = (
  run: RunRecord,
  responsibility: LoopResponsibility,
  reviewLane: ReviewLane | undefined
): ProgressPacketSourceRef[] => {
  const refs: ProgressPacketSourceRef[] = [
    ...responsibility.eventRefs.map((id): ProgressPacketSourceRef => ({
      kind: "run_event",
      runId: run.runId,
      id
    })),
    ...responsibility.artifactRefs.map((ref): ProgressPacketSourceRef => ({
      kind: "run_artifact",
      runId: run.runId,
      ref
    })),
    ...(reviewLane?.sourceRefs ?? [])
  ];

  return refs.length > 0
    ? unique(refs, sourceKey)
    : [{ kind: "run_record", runId: run.runId }];
};

const reviewLaneForResponsibility = (
  responsibility: LoopResponsibility,
  reviewLanes: ReviewLane[]
): ReviewLane | undefined => {
  switch (responsibility.kind) {
    case "qa":
      return reviewLanes.find((lane) => lane.kind === "qa");
    case "test":
      return reviewLanes.find((lane) => lane.kind === "tester" && lane.role === "qa");
    case "verify":
      return reviewLanes.find((lane) => lane.role === "verifier");
    case "critique":
      return reviewLanes.find((lane) => lane.role === "critic");
    default:
      return undefined;
  }
};

const laneAuthority = (responsibility: LoopResponsibility): CrewLaneAuthority => {
  if (responsibility.kind === "operator_approval") {
    return "operator";
  }

  if (responsibility.owner.kind === "runtime") {
    return "runtime";
  }

  if (responsibility.owner.readOnly || readonlyRoleKinds.has(responsibility.kind)) {
    return "read_only";
  }

  return "edit";
};

const laneSourceKind = (reviewLane: ReviewLane | undefined): CrewLaneSourceKind =>
  reviewLane ? "review_lane" : "loop_responsibility";

const satisfiesRequired = (
  responsibility: LoopResponsibility,
  reviewLane: ReviewLane | undefined
): boolean => {
  if (reviewLane) {
    return reviewLane.satisfiesRequired;
  }

  return responsibility.required && responsibility.status === "satisfied" && responsibility.canSatisfyGate;
};

const crewLaneFromResponsibility = (
  run: RunRecord,
  responsibility: LoopResponsibility,
  reviewLane: ReviewLane | undefined
): CrewLane => {
  const artifactRefs = uniqueStrings([
    ...responsibility.artifactRefs,
    ...(reviewLane?.artifactRefs ?? [])
  ]);
  const eventRefs = uniqueStrings([
    ...responsibility.eventRefs,
    ...(reviewLane?.eventRefs ?? [])
  ]);
  const sidecarOnly = Boolean(responsibility.sidecarOnly || reviewLane?.sourceKind === "summon_evidence");

  return {
    id: `crew-lane-${responsibility.kind}`,
    kind: responsibility.kind,
    label: responsibility.label,
    owner: responsibility.owner,
    authority: laneAuthority(responsibility),
    required: responsibility.required,
    blocking: responsibility.blocking,
    status: responsibility.status,
    state: responsibility.state,
    sourceKind: laneSourceKind(reviewLane),
    summary: responsibility.reason,
    responsibilityId: responsibility.id,
    ...(reviewLane ? { reviewLaneId: reviewLane.id } : {}),
    canSatisfyGate: responsibility.canSatisfyGate,
    satisfiesRequired: satisfiesRequired(responsibility, reviewLane),
    artifactRefs,
    eventRefs,
    handoffRefs: responsibility.handoffRefs,
    sourceRefs: sourceRefsForResponsibility(run, responsibility, reviewLane),
    ...(sidecarOnly ? { sidecarOnly: true } : {})
  };
};

export const deriveCrewLaneTrail = (run: RunRecord): CrewLaneTrail => {
  const schedule = deriveLoopResponsibilitySchedule(run);
  const reviewLanes = deriveReviewLanes(run);
  const lanes = schedule.responsibilities.map((responsibility) =>
    crewLaneFromResponsibility(run, responsibility, reviewLaneForResponsibility(responsibility, reviewLanes))
  );

  return {
    schemaVersion: 1,
    kind: "crew_lane_trail",
    runId: run.runId,
    generatedAt: nowIso(),
    phase: run.state,
    lanes,
    blockers: lanes.filter((lane) => lane.blocking)
  };
};
