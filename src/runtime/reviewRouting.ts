import type { JsonObject, RuntimeRole } from "./types.js";

export type ReviewRiskTier = "low" | "medium" | "high";

export type ReviewRoutingAction =
  | "run_qa"
  | "run_verifier"
  | "complete"
  | "ask_user";

export interface ReviewRoutingInput {
  changedPaths: string[];
  protectedChangeCount: number;
  validationCommandCount: number;
  validationFailureCount: number;
  hasQaAssignment: boolean;
  hasVerifierAssignment: boolean;
  hasQaResponse: boolean;
  hasVerifierResponse: boolean;
}

export interface ReviewRoutingDecision {
  schemaVersion: 1;
  kind: "review_routing";
  riskTier: ReviewRiskTier;
  action: ReviewRoutingAction;
  required: {
    validation: true;
    qa: boolean;
    verifier: boolean;
    critic: false;
  };
  skippedRoles: ReviewRoutingSkippedRole[];
  reasons: string[];
  signals: ReviewRoutingSignals;
  policy: {
    qa: "risk_gated";
    verifier: "conservative_required";
    critic: "escalation_only";
  };
}

export interface ReviewRoutingSignals {
  changedPathCount: number;
  protectedChangeCount: number;
  validationCommandCount: number;
  validationFailureCount: number;
  hasQaAssignment: boolean;
  hasVerifierAssignment: boolean;
  hasQaResponse: boolean;
  hasVerifierResponse: boolean;
  changedPathClasses: string[];
}

export interface ReviewRoutingSkippedRole {
  role: Extract<RuntimeRole, "qa" | "verifier" | "critic">;
  reason: string;
}

const docsPathPatterns = [
  /^README(?:\.[A-Za-z0-9_-]+)?$/i,
  /^CHANGELOG(?:\.[A-Za-z0-9_-]+)?$/i,
  /^CONTRIBUTING(?:\.[A-Za-z0-9_-]+)?$/i,
  /^SECURITY(?:\.[A-Za-z0-9_-]+)?$/i,
  /^LICENSE(?:\.[A-Za-z0-9_-]+)?$/i,
  /^docs\//,
  /\.md$/i,
  /\.mdx$/i,
  /\.txt$/i
];

const highRiskPathPatterns = [
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^bun\.lockb$/,
  /^src\/providers\//,
  /^src\/runtime\/(approvalPolicy|commandSafety|externalTransfer|loop|permissions|protectedPaths|responseContracts|revisionPacket|criticPolicy|validationCommands|types)\.ts$/,
  /^src\/runtime\/(agentRunner|directives|store|runtime|summons|fanout)\.ts$/,
  /^src\/mcp\//,
  /^scripts\/smoke-/,
  /(^|\/)(__snapshots__|fixtures|evals)(\/|$)/,
  /\.(spec|test)\.[A-Za-z0-9]+$/
];

const mediumRiskPathPatterns = [
  /^package\.json$/,
  /^src\/cli\//,
  /^src\/tui\//,
  /^src\/runtime\//,
  /^scripts\//,
  /^docs\/(CLI_SPEC|MCP_SPEC|PROVIDER_ADAPTERS|PROMPT_SCHEMAS|MEMORY_AND_RECONCILIATION)\.md$/
];

const matchesAny = (path: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(path));

const pathClass = (path: string): string => {
  if (matchesAny(path, highRiskPathPatterns)) {
    return "high";
  }

  if (matchesAny(path, mediumRiskPathPatterns)) {
    return "medium";
  }

  if (matchesAny(path, docsPathPatterns)) {
    return "docs";
  }

  return "unknown";
};

const unique = (values: string[]): string[] => Array.from(new Set(values));

const allChangedPathsAreDocs = (changedPaths: string[]): boolean =>
  changedPaths.length > 0 && changedPaths.every((path) => pathClass(path) === "docs");

const riskTier = (input: ReviewRoutingInput, classes: string[]): { tier: ReviewRiskTier; reasons: string[] } => {
  const reasons: string[] = [];

  if (input.protectedChangeCount > 0) {
    reasons.push("protected test, fixture, snapshot, or eval path changed");
  }

  if (input.validationFailureCount > 0) {
    reasons.push("deterministic validation captured failing command evidence");
  }

  if (classes.includes("high")) {
    reasons.push("high-risk runtime, provider, policy, MCP, validation, or test path changed");
  }

  if (reasons.length > 0) {
    return {
      tier: "high",
      reasons
    };
  }

  if (allChangedPathsAreDocs(input.changedPaths)) {
    return {
      tier: "low",
      reasons: ["all changed paths are docs, copy, or text surfaces"]
    };
  }

  if (input.changedPaths.length === 0) {
    return {
      tier: "medium",
      reasons: ["no changed paths were captured; semantic acceptance still needs independent review"]
    };
  }

  return {
    tier: "medium",
    reasons: classes.includes("medium")
      ? ["behavior, CLI/TUI, docs-spec, script, or runtime-adjacent path changed"]
      : ["changed paths are not docs-only and need standard review routing"]
  };
};

const skippedRoles = (
  input: ReviewRoutingInput,
  requiredQa: boolean,
  requiredVerifier: boolean
): ReviewRoutingSkippedRole[] => [
  ...(!input.hasQaAssignment
    ? [{ role: "qa" as const, reason: "QA role is not assigned for this run." }]
    : input.hasQaResponse
      ? [{ role: "qa" as const, reason: "QA already responded after the latest implementer pass." }]
      : !requiredQa
        ? [{ role: "qa" as const, reason: "Risk-gated policy does not require model QA for low-risk docs/copy changes." }]
        : []),
  ...(!input.hasVerifierAssignment
    ? [{ role: "verifier" as const, reason: "Verifier role is not assigned for this run." }]
    : input.hasVerifierResponse
      ? [{ role: "verifier" as const, reason: "Verifier already responded after the latest implementer pass." }]
      : !requiredVerifier
        ? [{ role: "verifier" as const, reason: "Verifier is not required by this routing decision." }]
        : []),
  { role: "critic" as const, reason: "Critic is escalation-only and is triggered by critic policy after QA/verifier evidence." }
];

export const decideReviewRouting = (input: ReviewRoutingInput): ReviewRoutingDecision => {
  const changedPathClasses = unique(input.changedPaths.map(pathClass));
  const risk = riskTier(input, changedPathClasses);
  const qaRequiredByRisk = risk.tier !== "low";
  const requiredQa = input.hasQaAssignment && qaRequiredByRisk;
  const requiredVerifier = input.hasVerifierAssignment;

  const action: ReviewRoutingAction =
    requiredQa && !input.hasQaResponse
      ? "run_qa"
      : requiredVerifier && !input.hasVerifierResponse
        ? "run_verifier"
        : input.hasVerifierAssignment
          ? "complete"
          : "ask_user";

  return {
    schemaVersion: 1,
    kind: "review_routing",
    riskTier: risk.tier,
    action,
    required: {
      validation: true,
      qa: requiredQa,
      verifier: requiredVerifier,
      critic: false
    },
    skippedRoles: skippedRoles(input, requiredQa, requiredVerifier),
    reasons: [
      ...risk.reasons,
      "deterministic validation is always required before subjective review routing",
      "verifier remains required in this conservative routing slice",
      "critic remains escalation-only and cannot satisfy validation or verifier gates"
    ],
    signals: {
      changedPathCount: input.changedPaths.length,
      protectedChangeCount: input.protectedChangeCount,
      validationCommandCount: input.validationCommandCount,
      validationFailureCount: input.validationFailureCount,
      hasQaAssignment: input.hasQaAssignment,
      hasVerifierAssignment: input.hasVerifierAssignment,
      hasQaResponse: input.hasQaResponse,
      hasVerifierResponse: input.hasVerifierResponse,
      changedPathClasses
    },
    policy: {
      qa: "risk_gated",
      verifier: "conservative_required",
      critic: "escalation_only"
    }
  };
};

export const reviewRoutingSummary = (decision: ReviewRoutingDecision): string =>
  `Review routing: ${decision.riskTier} risk -> ${decision.action}.`;

export const reviewRoutingJson = (decision: ReviewRoutingDecision): JsonObject =>
  decision as unknown as JsonObject;
