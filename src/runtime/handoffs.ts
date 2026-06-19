import { newId, nowIso } from "./ids.js";
import type {
  RoleAssignment,
  RunHandoffEvent,
  RunHandoffKind,
  RunRecord,
  RunState,
  RuntimeRole
} from "./types.js";

export interface CreateRunHandoffInput {
  kind: RunHandoffKind;
  reason: string;
  stateAfter: RunState;
  fromRole?: RuntimeRole | undefined;
  toRole?: RuntimeRole | undefined;
  gate?: string | undefined;
  approvalEventId?: string | undefined;
  artifactRefs?: string[] | undefined;
}

export interface RunHandoffSummary {
  id: string;
  createdAt: string;
  kind: RunHandoffKind;
  reason: string;
  stateBefore: RunState;
  stateAfter: RunState;
  fromLabel?: string;
  fromAssignment?: string;
  toLabel?: string;
  toAssignment?: string;
  gate?: string;
  artifactRefs?: string[];
}

const agentLaneRoles: RuntimeRole[] = [
  "orchestrator",
  "implementer",
  "qa",
  "verifier",
  "critic",
  "planner",
  "researcher",
  "integrator",
  "citation"
];

const titleCaseRole = (role: RuntimeRole): string =>
  role === "qa"
    ? "QA"
    : role
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");

export const roleLaneLabel = (role: RuntimeRole): string => {
  const index = agentLaneRoles.indexOf(role);
  const lane = index >= 0 ? index + 1 : agentLaneRoles.length + 1;

  return `Agent ${lane} / ${titleCaseRole(role)}`;
};

const assignmentForRole = (run: RunRecord, role: RuntimeRole | undefined): RoleAssignment | undefined =>
  role ? run.roleMapping[role] : undefined;

export const createRunHandoff = (
  run: RunRecord,
  input: CreateRunHandoffInput
): RunHandoffEvent => {
  const fromAssignment = assignmentForRole(run, input.fromRole);
  const toAssignment = assignmentForRole(run, input.toRole);
  const handoff: RunHandoffEvent = {
    id: newId("handoff"),
    createdAt: nowIso(),
    kind: input.kind,
    reason: input.reason,
    stateBefore: run.state,
    stateAfter: input.stateAfter
  };

  if (input.fromRole) {
    handoff.fromRole = input.fromRole;
  }

  if (fromAssignment) {
    handoff.fromProvider = fromAssignment.provider;
    handoff.fromModel = fromAssignment.model;
  }

  if (input.toRole) {
    handoff.toRole = input.toRole;
  }

  if (toAssignment) {
    handoff.toProvider = toAssignment.provider;
    handoff.toModel = toAssignment.model;
  }

  if (input.gate) {
    handoff.gate = input.gate;
  }

  if (input.approvalEventId) {
    handoff.approvalEventId = input.approvalEventId;
  }

  if (input.artifactRefs && input.artifactRefs.length > 0) {
    handoff.artifactRefs = input.artifactRefs;
  }

  return handoff;
};

export const appendRunHandoffs = (
  run: RunRecord,
  handoffs: RunHandoffEvent[]
): RunRecord => ({
  ...run,
  handoffs: [...(run.handoffs ?? []), ...handoffs]
});

export const latestRunHandoff = (run: RunRecord): RunHandoffEvent | undefined =>
  (run.handoffs ?? []).at(-1);

export const recentRunHandoffs = (run: RunRecord, limit: number): RunHandoffEvent[] =>
  (run.handoffs ?? []).slice(-limit);

const assignmentLabel = (provider: string | undefined, model: string | undefined): string | undefined =>
  provider && model ? `${provider}:${model}` : undefined;

export const summarizeRunHandoff = (handoff: RunHandoffEvent): RunHandoffSummary => {
  const summary: RunHandoffSummary = {
    id: handoff.id,
    createdAt: handoff.createdAt,
    kind: handoff.kind,
    reason: handoff.reason,
    stateBefore: handoff.stateBefore,
    stateAfter: handoff.stateAfter
  };

  if (handoff.fromRole) {
    summary.fromLabel = roleLaneLabel(handoff.fromRole);
  }

  const fromAssignment = assignmentLabel(handoff.fromProvider, handoff.fromModel);
  if (fromAssignment) {
    summary.fromAssignment = fromAssignment;
  }

  if (handoff.toRole) {
    summary.toLabel = roleLaneLabel(handoff.toRole);
  }

  const toAssignment = assignmentLabel(handoff.toProvider, handoff.toModel);
  if (toAssignment) {
    summary.toAssignment = toAssignment;
  }

  if (handoff.gate) {
    summary.gate = handoff.gate;
  }

  if (handoff.artifactRefs) {
    summary.artifactRefs = handoff.artifactRefs;
  }

  return summary;
};

export const recentRunHandoffSummaries = (run: RunRecord, limit: number): RunHandoffSummary[] =>
  recentRunHandoffs(run, limit).map(summarizeRunHandoff);
