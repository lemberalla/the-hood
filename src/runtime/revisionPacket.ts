import { writeRunArtifact } from "./artifacts.js";
import { newId, nowIso } from "./ids.js";
import type { AgentResponse } from "../providers/types.js";
import type { JsonObject, JsonValue, RunArtifact, RunRecord, RuntimeRole } from "./types.js";

export type RevisionPacketSourceRole = Extract<RuntimeRole, "qa" | "verifier" | "critic">;

export type RevisionPacketReasonCode =
  | "qa_needs_revision"
  | "verifier_revise"
  | "critic_needs_revision"
  | "critic_blocking_concerns";

export interface RevisionPacketDecision {
  shouldRevise: boolean;
  sourceRole?: RevisionPacketSourceRole;
  reasonCode?: RevisionPacketReasonCode;
  reason?: string;
  repairObjective?: string;
  acceptanceCriteria: string[];
}

export interface RevisionPacket {
  schemaVersion: 1;
  kind: "revision_packet";
  runId: string;
  createdAt: string;
  sourceRole: RevisionPacketSourceRole;
  reasonCode: RevisionPacketReasonCode;
  reason: string;
  repairObjective: string;
  acceptanceCriteria: string[];
  evidenceRefs: string[];
  sourceResponseRef?: string;
  criticTriggerRef?: string;
}

export interface WriteRevisionPacketInput {
  decision: RevisionPacketDecision;
  evidenceRefs: string[];
  sourceResponseRef?: string;
  criticTriggerRef?: string;
}

const maxTextLength = 500;
const maxCriteria = 8;

const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringField = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const truncateText = (value: string): string =>
  value.length <= maxTextLength ? value : `${value.slice(0, maxTextLength - 3)}...`;

const stringArrayField = (value: JsonValue | undefined): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

const unique = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values.map((item) => truncateText(item.trim())).filter(Boolean)) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    output.push(value);
  }

  return output.slice(0, maxCriteria);
};

const fallbackCriteria = (sourceRole: RevisionPacketSourceRole): string[] => [
  `Address the ${sourceRole} revision finding without expanding the requested scope.`,
  "Preserve runtime approval, protected-path, and verifier separation invariants.",
  "Leave evidence that lets QA and verifier re-check the repair."
];

const qaDecision = (response: AgentResponse): RevisionPacketDecision => {
  const payload = isJsonObject(response.data.qaResult) ? response.data.qaResult : undefined;
  const verdict = stringField(payload?.verdict);

  if (verdict !== "needs_revision") {
    return {
      shouldRevise: false,
      acceptanceCriteria: []
    };
  }

  const summary = stringField(payload?.summary) ?? response.summary;
  const criteria = unique([
    ...stringArrayField(payload?.risks),
    ...stringArrayField(payload?.missedCases),
    ...stringArrayField(payload?.suggestedCommands).map((command) => `Consider runtime validation: ${command}`)
  ]);

  return {
    shouldRevise: true,
    sourceRole: "qa",
    reasonCode: "qa_needs_revision",
    reason: summary,
    repairObjective: `Repair the issue found by QA tester evidence: ${summary}`,
    acceptanceCriteria: criteria.length > 0 ? criteria : fallbackCriteria("qa")
  };
};

const verifierDecision = (response: AgentResponse): RevisionPacketDecision => {
  const payload = isJsonObject(response.data.verificationResult) ? response.data.verificationResult : undefined;
  const verdict = stringField(payload?.verdict);

  if (verdict !== "revise") {
    return {
      shouldRevise: false,
      acceptanceCriteria: []
    };
  }

  const summary = stringField(payload?.summary) ?? response.summary;
  const criteria = unique([
    ...stringArrayField(payload?.failedCriteria),
    ...stringArrayField(payload?.risks)
  ]);

  return {
    shouldRevise: true,
    sourceRole: "verifier",
    reasonCode: "verifier_revise",
    reason: summary,
    repairObjective: `Repair the verifier revision finding: ${summary}`,
    acceptanceCriteria: criteria.length > 0 ? criteria : fallbackCriteria("verifier")
  };
};

const criticDecision = (response: AgentResponse): RevisionPacketDecision => {
  const payload = isJsonObject(response.data.critiqueResult) ? response.data.critiqueResult : undefined;
  const verdict = stringField(payload?.verdict);
  const blockingConcerns = stringArrayField(payload?.blockingConcerns);

  if (verdict !== "needs_revision") {
    return {
      shouldRevise: false,
      acceptanceCriteria: []
    };
  }

  const reason = blockingConcerns[0] ?? response.summary;
  const criteria = unique([
    ...blockingConcerns,
    ...stringArrayField(payload?.nonBlockingConcerns)
  ]);

  return {
    shouldRevise: true,
    sourceRole: "critic",
    reasonCode: blockingConcerns.length > 0 ? "critic_blocking_concerns" : "critic_needs_revision",
    reason,
    repairObjective: `Repair the critic finding: ${reason}`,
    acceptanceCriteria: criteria.length > 0 ? criteria : fallbackCriteria("critic")
  };
};

export const decideRevisionPacket = (
  sourceRole: RevisionPacketSourceRole,
  response: AgentResponse
): RevisionPacketDecision => {
  switch (sourceRole) {
    case "qa":
      return qaDecision(response);
    case "verifier":
      return verifierDecision(response);
    case "critic":
      return criticDecision(response);
  }
};

export const buildRevisionPacket = (
  run: RunRecord,
  input: WriteRevisionPacketInput
): RevisionPacket => {
  const { decision } = input;

  if (!decision.shouldRevise || !decision.sourceRole || !decision.reasonCode || !decision.reason || !decision.repairObjective) {
    throw new Error("Cannot build a revision packet without a complete revision decision.");
  }

  return {
    schemaVersion: 1,
    kind: "revision_packet",
    runId: run.runId,
    createdAt: nowIso(),
    sourceRole: decision.sourceRole,
    reasonCode: decision.reasonCode,
    reason: truncateText(decision.reason),
    repairObjective: truncateText(decision.repairObjective),
    acceptanceCriteria: unique(decision.acceptanceCriteria),
    evidenceRefs: unique(input.evidenceRefs),
    ...(input.sourceResponseRef ? { sourceResponseRef: input.sourceResponseRef } : {}),
    ...(input.criticTriggerRef ? { criticTriggerRef: input.criticTriggerRef } : {})
  };
};

export const writeRevisionPacketArtifact = async (
  run: RunRecord,
  input: WriteRevisionPacketInput
): Promise<{ artifact: RunArtifact; packet: RevisionPacket }> => {
  const packet = buildRevisionPacket(run, input);
  const artifact = await writeRunArtifact({
    repoPath: run.repoPath,
    runId: run.runId,
    kind: "revision_packet",
    name: `revision-${newId("revision")}.json`,
    content: `${JSON.stringify(packet, null, 2)}\n`,
    summary: `Revision packet from ${packet.sourceRole}: ${packet.reasonCode}`
  });

  return {
    artifact,
    packet
  };
};
