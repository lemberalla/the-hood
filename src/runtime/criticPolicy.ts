import type { AgentResponse } from "../providers/types.js";
import type { JsonObject, RuntimeRole } from "./types.js";

export type CriticTriggerReasonCode =
  | "qa_failed"
  | "qa_inconclusive"
  | "verifier_failed"
  | "verifier_inconclusive"
  | "validation_mismatch";

export interface CriticTriggerDecision {
  callCritic: boolean;
  reasonCode?: CriticTriggerReasonCode;
  reason?: string;
  sourceRoles: RuntimeRole[];
  evidenceRefs: string[];
}

export interface CriticTriggerInput {
  qaResponse?: AgentResponse;
  verifierResponse?: AgentResponse;
  validationFailureCount?: number;
  evidenceRefs?: string[];
}

const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const trigger = (
  reasonCode: CriticTriggerReasonCode,
  reason: string,
  sourceRoles: RuntimeRole[],
  evidenceRefs: string[]
): CriticTriggerDecision => ({
  callCritic: true,
  reasonCode,
  reason,
  sourceRoles,
  evidenceRefs
});

const noTrigger = (evidenceRefs: string[]): CriticTriggerDecision => ({
  callCritic: false,
  sourceRoles: [],
  evidenceRefs
});

const qaVerdict = (response: AgentResponse | undefined): string | undefined =>
  isJsonObject(response?.data.qaResult) ? stringField(response.data.qaResult.verdict) : undefined;

const verifierVerdict = (response: AgentResponse | undefined): string | undefined =>
  isJsonObject(response?.data.verificationResult) ? stringField(response.data.verificationResult.verdict) : undefined;

export const decideCriticTrigger = (input: CriticTriggerInput): CriticTriggerDecision => {
  const evidenceRefs = input.evidenceRefs ?? [];

  if (input.verifierResponse?.status === "failed") {
    return trigger("verifier_failed", "Verifier response failed before work could be accepted.", ["verifier"], evidenceRefs);
  }

  if (input.verifierResponse?.status === "blocked") {
    return trigger("verifier_inconclusive", "Verifier response was blocked and needs an advisory critic review.", ["verifier"], evidenceRefs);
  }

  const verifier = verifierVerdict(input.verifierResponse);
  if (verifier === "revise" || verifier === "abort") {
    return trigger("verifier_failed", `Verifier returned ${verifier}; critic should review the revision risk.`, ["verifier"], evidenceRefs);
  }

  if (verifier === "ask_user") {
    return trigger("verifier_inconclusive", "Verifier asked for user input; critic should review the unresolved evidence.", ["verifier"], evidenceRefs);
  }

  if ((input.validationFailureCount ?? 0) > 0) {
    return trigger("validation_mismatch", "Runtime validation captured failing command evidence.", ["qa", "verifier"], evidenceRefs);
  }

  if (input.qaResponse?.status === "failed") {
    return trigger("qa_failed", "QA tester response failed before verifier review.", ["qa"], evidenceRefs);
  }

  if (input.qaResponse?.status === "blocked") {
    return trigger("qa_inconclusive", "QA tester response was blocked and could not confirm risk.", ["qa"], evidenceRefs);
  }

  const qa = qaVerdict(input.qaResponse);
  if (qa === "needs_revision") {
    return trigger("qa_failed", "QA tester requested revision before verifier review.", ["qa"], evidenceRefs);
  }

  if (qa === "needs_more_evidence" || qa === "blocked") {
    return trigger("qa_inconclusive", "QA tester requested more evidence before verifier review.", ["qa"], evidenceRefs);
  }

  return noTrigger(evidenceRefs);
};
