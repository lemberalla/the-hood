import { nowIso } from "./ids.js";
import type {
  ProgressPacketSourceRef,
  RevisionTrail,
  RevisionTrailItem,
  RevisionTrailStatus,
  RunEvent,
  RunHandoffEvent,
  RunRecord,
  RuntimeRole
} from "./types.js";

const reviewRoles = new Set<RuntimeRole>(["qa", "verifier"]);

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const stringArrayField = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

const roleField = (value: unknown): RuntimeRole | undefined => {
  const role = stringField(value);

  return role === "qa" || role === "verifier" || role === "critic" ? role : undefined;
};

const uniqueStrings = (values: string[]): string[] =>
  [...new Set(values.filter((value) => value.trim().length > 0))];

const sourceKey = (source: ProgressPacketSourceRef): string =>
  [source.kind, source.runId, source.id ?? "", source.ref ?? "", source.eventType ?? ""].join(":");

const uniqueSources = (values: ProgressPacketSourceRef[]): ProgressPacketSourceRef[] => {
  const seen = new Set<string>();
  const result: ProgressPacketSourceRef[] = [];

  for (const value of values) {
    const key = sourceKey(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }

  return result;
};

const eventIndex = (run: RunRecord, event: RunEvent | undefined): number =>
  event ? run.events.findIndex((candidate) => candidate.id === event.id) : -1;

const packetArtifactRef = (event: RunEvent): string | undefined =>
  event.type === "revision_packet_written" ? stringField(event.data?.artifactRef) : undefined;

const eventAfter = (
  run: RunRecord,
  startIndex: number,
  predicate: (event: RunEvent) => boolean
): RunEvent | undefined =>
  run.events.find((event, index) => index > startIndex && predicate(event));

const eventsAfter = (
  run: RunRecord,
  startIndex: number,
  predicate: (event: RunEvent) => boolean
): RunEvent[] =>
  run.events.filter((event, index) => index > startIndex && predicate(event));

const handoffAfter = (
  run: RunRecord,
  after: RunEvent,
  artifactRef: string
): RunHandoffEvent | undefined =>
  run.handoffs.find((handoff) =>
    handoff.createdAt >= after.createdAt &&
    handoff.kind === "agent_handoff" &&
    handoff.toRole === "implementer" &&
    handoff.artifactRefs?.includes(artifactRef) === true
  );

const responseArtifactRef = (event: RunEvent | undefined): string | undefined =>
  stringField(event?.data?.artifactRef);

const validationArtifactRefs = (events: RunEvent[]): string[] =>
  uniqueStrings(events.map((event) => stringField(event.data?.artifactRef)).filter((ref): ref is string => Boolean(ref)));

const trailStatus = (input: {
  nextPacket: RunEvent | undefined;
  delegation: RunEvent | undefined;
  repairResponse: RunEvent | undefined;
  validationEvents: RunEvent[];
  reviewResponses: RunEvent[];
  completion: RunEvent | undefined;
  run: RunRecord;
}): RevisionTrailStatus => {
  if (input.nextPacket) {
    return "superseded";
  }

  if (input.completion || input.reviewResponses.some((event) => event.data?.role === "verifier")) {
    return "reviewed";
  }

  if (input.validationEvents.length > 0 || input.reviewResponses.length > 0) {
    return "awaiting_review";
  }

  if (input.repairResponse) {
    return "repair_reported";
  }

  if (input.delegation && input.run.state === "implementing") {
    return "repairing";
  }

  if (input.delegation) {
    return "delegated";
  }

  return "packet_written";
};

const sourceRefs = (
  run: RunRecord,
  events: RunEvent[],
  artifactRefs: string[]
): ProgressPacketSourceRef[] =>
  uniqueSources([
    ...events.map((event): ProgressPacketSourceRef => ({
      kind: "run_event",
      runId: run.runId,
      id: event.id,
      eventType: event.type
    })),
    ...artifactRefs.map((ref): ProgressPacketSourceRef => ({
      kind: "run_artifact",
      runId: run.runId,
      ref
    }))
  ]);

const itemForPacket = (
  run: RunRecord,
  packetEvent: RunEvent,
  nextPacket: RunEvent | undefined
): RevisionTrailItem | undefined => {
  const artifactRef = packetArtifactRef(packetEvent);

  if (!artifactRef) {
    return undefined;
  }

  const packetIndex = eventIndex(run, packetEvent);
  const delegation = eventAfter(run, packetIndex, (event) =>
    event.type === "revision_delegated" && event.data?.artifactRef === artifactRef
  );
  const delegationIndex = eventIndex(run, delegation);
  const repairResponse = eventAfter(run, delegationIndex >= 0 ? delegationIndex : packetIndex, (event) =>
    event.type === "agent_response" && event.data?.role === "implementer"
  );
  const repairIndex = eventIndex(run, repairResponse);
  const evidenceStart = repairIndex >= 0 ? repairIndex : delegationIndex >= 0 ? delegationIndex : packetIndex;
  const validationEvents = eventsAfter(run, evidenceStart, (event) => event.type === "validation_evidence_captured");
  const reviewResponses = eventsAfter(run, evidenceStart, (event) =>
    event.type === "agent_response" && reviewRoles.has(event.data?.role as RuntimeRole)
  );
  const completion = eventAfter(run, evidenceStart, (event) => event.type === "run_completed");
  const handoff = delegation ? handoffAfter(run, delegation, artifactRef) : undefined;
  const sourceRole = roleField(packetEvent.data?.sourceRole);
  const reasonCode = stringField(packetEvent.data?.reasonCode);
  const repairObjective = stringField(delegation?.data?.repairObjective);
  const evidenceRefs = stringArrayField(packetEvent.data?.evidenceRefs);
  const sourceResponseRef = stringField(packetEvent.data?.sourceResponseRef);
  const criticTriggerRef = stringField(packetEvent.data?.criticTriggerRef);
  const repairResponseRef = responseArtifactRef(repairResponse);
  const reviewResponseRefs = uniqueStrings(reviewResponses.map(responseArtifactRef).filter((ref): ref is string => Boolean(ref)));
  const validationRefs = validationArtifactRefs(validationEvents);
  const artifactRefs = uniqueStrings([
    artifactRef,
    ...evidenceRefs,
    ...(sourceResponseRef ? [sourceResponseRef] : []),
    ...(criticTriggerRef ? [criticTriggerRef] : []),
    ...(repairResponseRef ? [repairResponseRef] : []),
    ...validationRefs,
    ...reviewResponseRefs
  ]);
  const eventRefs = uniqueStrings([
    packetEvent.id,
    ...(delegation ? [delegation.id] : []),
    ...(repairResponse ? [repairResponse.id] : []),
    ...validationEvents.map((event) => event.id),
    ...reviewResponses.map((event) => event.id),
    ...(completion ? [completion.id] : [])
  ]);
  const status = trailStatus({
    nextPacket,
    delegation,
    repairResponse,
    validationEvents,
    reviewResponses,
    completion,
    run
  });
  const active = !nextPacket && !["reviewed", "superseded"].includes(status);

  return {
    id: `revision-trail-${packetEvent.id}`,
    status,
    active,
    packetArtifactRef: artifactRef,
    ...(sourceRole ? { sourceRole } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    ...(repairObjective ? { repairObjective } : {}),
    ...(sourceResponseRef ? { sourceResponseRef } : {}),
    ...(criticTriggerRef ? { criticTriggerRef } : {}),
    ...(repairResponseRef ? { repairResponseRef } : {}),
    ...(completion ? { completedEventRef: completion.id } : {}),
    evidenceRefs,
    validationArtifactRefs: validationRefs,
    reviewResponseRefs,
    artifactRefs,
    eventRefs,
    handoffRefs: handoff ? [handoff.id] : [],
    sourceRefs: sourceRefs(run, [
      packetEvent,
      ...[delegation, repairResponse, completion].filter((event): event is RunEvent => Boolean(event)),
      ...validationEvents,
      ...reviewResponses
    ], artifactRefs)
  };
};

export const deriveRevisionTrail = (run: RunRecord): RevisionTrail => {
  const packetEvents = run.events.filter((event) => packetArtifactRef(event));
  const items = packetEvents
    .map((event, index) => itemForPacket(run, event, packetEvents[index + 1]))
    .filter((item): item is RevisionTrailItem => Boolean(item));
  const latest = items.at(-1);

  return {
    schemaVersion: 1,
    kind: "revision_trail",
    runId: run.runId,
    generatedAt: nowIso(),
    phase: run.state,
    items,
    ...(latest ? { latest } : {})
  };
};
