import { readRunArtifact } from "./artifacts.js";
import { runAgent } from "./agentRunner.js";
import { autoApprovalReason, evaluateExternalTransferPolicy } from "./approvalPolicy.js";
import { loadConfig } from "./config.js";
import { InputError } from "./errors.js";
import {
  transferManifestSummary,
  writeExternalTransferManifestArtifact
} from "./externalTransfer.js";
import { newId, nowIso } from "./ids.js";
import { writeProgressPacketArtifact } from "./progressPacket.js";
import { loadRun, saveRun } from "./store.js";
import type { AgentResponse } from "../providers/types.js";
import type {
  ApprovalEvent,
  JsonObject,
  RoleAssignment,
  RunArtifact,
  RunEvent,
  RunRecord,
  RuntimeRole
} from "./types.js";

export interface ReconcileRunInput {
  repoPath: string;
  runId: string;
  role?: RuntimeRole;
}

export interface ReconcileRunResult {
  run: RunRecord;
  advanced: boolean;
  stopReason: string;
  role: RuntimeRole;
  progressArtifact?: RunArtifact;
  reconciliationArtifact?: RunArtifact;
  providerResponses: AgentResponse[];
}

interface ProgressPacketTransferReview {
  run: RunRecord;
  gated?: ReconcileRunResult;
}

const providersRequiringProgressPacketApproval = new Set(["chatgpt-web", "chatgpt-atlas", "openai-api", "anthropic-api"]);

const createEvent = (type: string, message: string, data?: JsonObject): RunEvent => ({
  id: newId("event"),
  createdAt: nowIso(),
  type,
  message,
  ...(data ? { data } : {})
});

const createApprovalEvent = (reason: string): ApprovalEvent => ({
  id: newId("approval"),
  createdAt: nowIso(),
  decision: "approve",
  reason
});

const artifactSummary = (artifact: RunArtifact): JsonObject => ({
  kind: artifact.kind,
  ref: artifact.ref,
  summary: artifact.summary
});

const reconciliationRoleForRun = (run: RunRecord, preferredRole?: RuntimeRole): RuntimeRole => {
  if (preferredRole) {
    if (preferredRole !== "planner" && preferredRole !== "orchestrator") {
      throw new InputError("Reconciliation role must be planner or orchestrator.");
    }

    if (!run.roleMapping[preferredRole]) {
      throw new InputError(`Run ${run.runId} does not have a ${preferredRole} role assignment.`);
    }

    return preferredRole;
  }

  return run.roleMapping.planner ? "planner" : "orchestrator";
};

const requiredAssignment = (run: RunRecord, role: RuntimeRole): RoleAssignment => {
  const assignment = run.roleMapping[role];

  if (!assignment) {
    throw new InputError(`Run ${run.runId} does not have a ${role} role assignment.`);
  }

  return assignment;
};

const latestProgressArtifact = (run: RunRecord): RunArtifact | undefined =>
  run.artifacts.filter((artifact) => artifact.kind === "progress").at(-1);

const latestProgressPacketWrittenAt = (run: RunRecord): string | undefined =>
  run.events.filter((event) => event.type === "progress_packet_written").at(-1)?.createdAt;

const approvalMentionsProgressPacketShare = (reason: string, assignment: RoleAssignment): boolean => {
  const normalized = reason.toLowerCase();
  const providerTokens = [
    assignment.provider,
    assignment.provider.replace(/-/g, " "),
    assignment.model,
    assignment.model.replace(/-/g, " ")
  ];

  return (
    normalized.includes("progress packet") &&
    (normalized.includes("send") || normalized.includes("share")) &&
    providerTokens.some((token) => token && normalized.includes(token.toLowerCase()))
  );
};

const hasExternalProgressPacketApproval = (run: RunRecord, assignment: RoleAssignment): boolean => {
  const capturedAt = latestProgressPacketWrittenAt(run);

  return run.approvalEvents.some(
    (approval) =>
      approval.decision === "approve" &&
      (!capturedAt || approval.createdAt >= capturedAt) &&
      approvalMentionsProgressPacketShare(approval.reason, assignment)
  );
};

const externalProgressPacketApprovalReason = (
  role: RuntimeRole,
  assignment: RoleAssignment,
  artifact: RunArtifact,
  approvalPhrase: string
): string =>
  `Sending progress packet to ${assignment.provider}:${assignment.model} for ${role} reconciliation requires explicit approval. ` +
  `Approval message must mention "${approvalPhrase}". Review the transfer manifest before approving. ` +
  `Progress artifact: ${artifact.summary}`;

const ensureProgressArtifact = async (run: RunRecord): Promise<{ run: RunRecord; artifact: RunArtifact }> => {
  const existing = latestProgressArtifact(run);
  if (existing) {
    return {
      run,
      artifact: existing
    };
  }

  if (run.state !== "completed") {
    throw new InputError("Only completed runs can be reconciled.");
  }

  const written = await writeProgressPacketArtifact(run);
  return {
    run: written.run,
    artifact: written.artifact
  };
};

const gateProgressPacketTransfer = async (
  run: RunRecord,
  role: RuntimeRole,
  assignment: RoleAssignment,
  progressArtifact: RunArtifact
): Promise<ProgressPacketTransferReview> => {
  if (
    !providersRequiringProgressPacketApproval.has(assignment.provider) ||
    hasExternalProgressPacketApproval(run, assignment)
  ) {
    return {
      run
    };
  }

  if (run.approvalRequired) {
    return {
      run,
      gated: {
        run,
        advanced: false,
        stopReason: run.approvalReason ?? "Approval is required before reconciliation can continue.",
        role,
        progressArtifact,
        providerResponses: []
      }
    };
  }

  const approvalPhrase = `send progress packet to ${assignment.provider}`;
  const transfer = await writeExternalTransferManifestArtifact({
    run,
    role,
    destination: assignment,
    purpose: "progress_packet",
    approvalPhrase,
    artifacts: [progressArtifact]
  });
  const config = await loadConfig(run.repoPath);
  const policyEvaluation = evaluateExternalTransferPolicy(config, transfer.manifest);
  const approvalReason = externalProgressPacketApprovalReason(role, assignment, progressArtifact, approvalPhrase);
  const transferEvent = createEvent("external_transfer_manifest_written", transfer.artifact.summary, {
    role,
    provider: assignment.provider,
    model: assignment.model,
    reason: "progress_packet_external_transfer",
    artifactRef: transfer.artifact.ref,
    artifactSummary: transfer.artifact.summary,
    sourceArtifactRef: progressArtifact.ref,
    sourceArtifactSummary: progressArtifact.summary,
    transfer: transferManifestSummary(transfer.manifest)
  });

  if (policyEvaluation.decision === "auto_approve") {
    const approval = createApprovalEvent(autoApprovalReason(transfer.manifest, policyEvaluation));
    const approved: RunRecord = {
      ...run,
      updatedAt: nowIso(),
      approvalRequired: false,
      artifacts: [...run.artifacts, transfer.artifact],
      approvalEvents: [...run.approvalEvents, approval],
      events: [
        ...run.events,
        transferEvent,
        createEvent("approval_auto_approved", approval.reason, {
          role,
          provider: assignment.provider,
          model: assignment.model,
          reason: "progress_packet_external_transfer",
          policyDecision: policyEvaluation.decision,
          policyReason: policyEvaluation.reason,
          artifactRef: transfer.artifact.ref,
          sourceArtifactRef: progressArtifact.ref,
          transfer: transferManifestSummary(transfer.manifest)
        })
      ]
    };

    await saveRun(approved);
    return {
      run: approved
    };
  }

  const gated: RunRecord = {
    ...run,
    updatedAt: nowIso(),
    approvalRequired: true,
    approvalReason,
    artifacts: [...run.artifacts, transfer.artifact],
    events: [
      ...run.events,
      transferEvent,
      createEvent("approval_required", approvalReason, {
        role,
        provider: assignment.provider,
        model: assignment.model,
        reason: "progress_packet_external_transfer",
        artifactRef: transfer.artifact.ref,
        artifactSummary: transfer.artifact.summary,
        sourceArtifactRef: progressArtifact.ref,
        sourceArtifactSummary: progressArtifact.summary,
        transfer: transferManifestSummary(transfer.manifest)
      })
    ]
  };

  await saveRun(gated);

  return {
    run: gated,
    gated: {
      run: gated,
      advanced: true,
      stopReason: approvalReason,
      role,
      progressArtifact,
      providerResponses: []
    }
  };
};

const readProgressPacket = async (run: RunRecord, progressArtifact: RunArtifact): Promise<JsonObject> => {
  const result = await readRunArtifact({
    repoPath: run.repoPath,
    runId: run.runId,
    ref: progressArtifact.ref,
    maxBytes: 200_000
  });

  if (result.truncated) {
    throw new InputError(`Progress packet artifact is too large to reconcile safely: ${progressArtifact.ref}`);
  }

  const parsed = JSON.parse(result.content) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InputError(`Progress packet artifact is not a JSON object: ${progressArtifact.ref}`);
  }

  return parsed as JsonObject;
};

const attachReconciliationEvent = async (
  run: RunRecord,
  input: {
    role: RuntimeRole;
    assignment: RoleAssignment;
    response: AgentResponse;
    progressArtifact: RunArtifact;
    reconciliationArtifact: RunArtifact;
  }
): Promise<RunRecord> => {
  const latest = await loadRun(run.repoPath, run.runId);
  const eventType = input.response.status === "ok" ? "reconciliation_completed" : "reconciliation_blocked";
  const message =
    input.response.status === "ok"
      ? `${input.role} reconciled progress packet.`
      : `${input.role} reconciliation returned ${input.response.status}: ${input.response.summary}`;
  const updated: RunRecord = {
    ...latest,
    updatedAt: nowIso(),
    events: [
      ...latest.events,
      createEvent(eventType, message, {
        role: input.role,
        provider: input.assignment.provider,
        model: input.assignment.model,
        responseStatus: input.response.status,
        progressArtifactRef: input.progressArtifact.ref,
        reconciliationArtifactRef: input.reconciliationArtifact.ref
      })
    ]
  };

  await saveRun(updated);
  return updated;
};

export const reconcileRun = async (input: ReconcileRunInput): Promise<ReconcileRunResult> => {
  const loaded = await loadRun(input.repoPath, input.runId);

  if (loaded.state !== "completed") {
    throw new InputError("Only completed runs can be reconciled.");
  }

  const role = reconciliationRoleForRun(loaded, input.role);
  const assignment = requiredAssignment(loaded, role);
  const progress = await ensureProgressArtifact(loaded);
  const transferReview = await gateProgressPacketTransfer(progress.run, role, assignment, progress.artifact);

  if (transferReview.gated) {
    return transferReview.gated;
  }

  const progressPacket = await readProgressPacket(transferReview.run, progress.artifact);
  const result = await runAgent(
    transferReview.run,
    role,
    {
      phase: "reconcile",
      progressPacket,
      progressPacketArtifact: artifactSummary(progress.artifact),
      instructions: [
        "Reconcile the stored plan state against the runtime progress packet.",
        "Identify completed items, still-open criteria, implementation deviations, and the smallest next slice.",
        "Treat artifact refs and runtime events as authoritative; summaries are derived navigation aids."
      ]
    },
    {
      responseArtifactKind: "reconciliation",
      responseArtifactNamePrefix: `${role}-reconciliation`,
      responseArtifactSummary: (response) => `${role} reconciliation: ${response.summary}`,
      responseEventType: "reconciliation_response"
    }
  );
  const reconciled = await attachReconciliationEvent(result.run, {
    role,
    assignment,
    response: result.response,
    progressArtifact: progress.artifact,
    reconciliationArtifact: result.responseArtifact
  });
  const stopReason =
    result.response.status === "ok"
      ? `${role} reconciled progress packet.`
      : `${role} reconciliation returned ${result.response.status}: ${result.response.summary}`;

  return {
    run: reconciled,
    advanced: true,
    stopReason,
    role,
    progressArtifact: progress.artifact,
    reconciliationArtifact: result.responseArtifact,
    providerResponses: [result.response]
  };
};
