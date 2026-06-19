import type {
  ExternalTransferManifest,
  ExternalTransferPolicyDecision,
  ExternalTransferPolicyRule,
  TheHoodConfig
} from "./types.js";

export interface ExternalTransferPolicyEvaluation {
  decision: ExternalTransferPolicyDecision;
  reason: string;
}

export const activeApprovalPolicyMode = (config: TheHoodConfig): TheHoodConfig["approvalPolicy"]["mode"] =>
  config.approvalPolicy.mode ?? config.approvalPolicy.externalTransfers.mode;

export const isAutopilotEnabled = (config: TheHoodConfig): boolean =>
  activeApprovalPolicyMode(config) === "autopilot";

export const autopilotApprovalReason = (summary: string): string =>
  `Auto-approved by TheHood autopilot policy: ${summary}`;

const ruleMatches = (
  rule: ExternalTransferPolicyRule,
  manifest: ExternalTransferManifest
): boolean => {
  if (rule.provider && rule.provider !== manifest.destination.provider) {
    return false;
  }

  if (rule.model && rule.model !== manifest.destination.model) {
    return false;
  }

  if (rule.purposes && !rule.purposes.includes(manifest.purpose)) {
    return false;
  }

  if (rule.riskClasses && !rule.riskClasses.includes(manifest.risk.class)) {
    return false;
  }

  if (rule.maxBytes !== undefined && manifest.totalBytes > rule.maxBytes) {
    return false;
  }

  return true;
};

export const evaluateExternalTransferPolicy = (
  config: TheHoodConfig,
  manifest: ExternalTransferManifest
): ExternalTransferPolicyEvaluation => {
  const policy = config.approvalPolicy.externalTransfers;
  const mode = activeApprovalPolicyMode(config);
  const matchingRule = policy.rules.find((rule) => ruleMatches(rule, manifest));

  if (matchingRule) {
    return {
      decision: matchingRule.decision,
      reason: `Matched external transfer policy rule for ${manifest.destination.provider}:${manifest.destination.model}.`
    };
  }

  if (
    mode === "autopilot" &&
    manifest.risk.class !== "secret_risk" &&
    manifest.totalBytes <= policy.maxAutoApproveBytes
  ) {
    return {
      decision: "auto_approve",
      reason:
        `Approval policy autopilot allowed ${manifest.purpose} ` +
        `(${manifest.totalBytes}/${policy.maxAutoApproveBytes} bytes, risk ${manifest.risk.class}).`
    };
  }

  if (
    (mode === "auto_low_risk" || policy.mode === "auto_low_risk") &&
    manifest.risk.class !== "secret_risk" &&
    manifest.totalBytes <= policy.maxAutoApproveBytes
  ) {
    return {
      decision: "auto_approve",
      reason:
        `External transfer policy auto_low_risk allowed ${manifest.purpose} ` +
        `(${manifest.totalBytes}/${policy.maxAutoApproveBytes} bytes, risk ${manifest.risk.class}).`
    };
  }

  return {
    decision: "manual",
    reason:
      `External transfer policy requires manual approval ` +
      `(${manifest.purpose}, risk ${manifest.risk.class}, ${manifest.totalBytes} bytes).`
  };
};

export const autoApprovalReason = (
  manifest: ExternalTransferManifest,
  evaluation: ExternalTransferPolicyEvaluation
): string =>
  `Auto-approved by TheHood approval policy: ${manifest.approvalHint} ${evaluation.reason}`;
