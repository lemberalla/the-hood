import fs from "node:fs/promises";
import { requiredAssignment, runAgent } from "./agentRunner.js";
import {
  autopilotApprovalReason,
  autopilotPolicyReason,
  autoApprovalReason,
  evaluateExternalTransferPolicy,
  isAutopilotEnabled
} from "./approvalPolicy.js";
import { writeRunArtifact } from "./artifacts.js";
import { runRuntimeCommand } from "./commandRunner.js";
import { loadConfig } from "./config.js";
import { deriveCrewLaneTrail } from "./crewLanes.js";
import {
  transferManifestSummary,
  writeExternalTransferManifestArtifact
} from "./externalTransfer.js";
import { createRunHandoff } from "./handoffs.js";
import { captureGitEvidence, parseGitStatusPaths } from "./gitEvidence.js";
import { decideCriticTrigger, type CriticTriggerDecision } from "./criticPolicy.js";
import { newId, nowIso } from "./ids.js";
import { findProtectedPathMatches, type ProtectedPathMatch } from "./protectedPaths.js";
import { writeProgressPacketArtifact } from "./progressPacket.js";
import {
  decideRevisionPacket,
  writeRevisionPacketArtifact,
  type RevisionPacketDecision
} from "./revisionPacket.js";
import { deriveRevisionTrail } from "./revisionTrail.js";
import {
  decideReviewRouting,
  reviewRoutingJson,
  reviewRoutingSummary,
  type ReviewRoutingDecision
} from "./reviewRouting.js";
import { deriveReviewLanes } from "./reviewLanes.js";
import {
  analyzeRepoContextRequest,
  captureRepoContext,
  latestRepoContextArtifact,
  readCombinedRepoContext,
  repoContextArtifacts
} from "./repoContext.js";
import {
  captureRemoteRepoContext,
  latestRemoteRepoContextArtifact,
  readLatestRemoteRepoContext,
  remoteRepoContextArtifacts
} from "./remoteRepoContext.js";
import { loadRun, saveRun } from "./store.js";
import { captureValidationEvidence } from "./validationCommands.js";
import type { AgentResponse } from "../providers/types.js";
import {
  runtimeRoles,
  type ApprovalEvent,
  type JsonObject,
  type JsonValue,
  type RoleAssignment,
  type RunArtifact,
  type RunEvent,
  type RunHandoffEvent,
  type RunRecord,
  type RunState,
  type RuntimeRole,
  type ToolEvent
} from "./types.js";

export interface AdvanceRunInput {
  repoPath: string;
  runId: string;
  maxSteps?: number;
}

export interface AdvanceRunResult {
  run: RunRecord;
  advanced: boolean;
  stopReason: string;
  providerResponses: AgentResponse[];
}

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

const autoApproveGate = async (
  run: RunRecord,
  input: {
    gate: string;
    reason: string;
    state?: RunState;
    role?: RuntimeRole;
    data?: JsonObject;
    artifactRefs?: string[];
  }
): Promise<RunRecord> => {
  const { approvalReason: _approvalReason, ...base } = run;
  const approvalReason = autopilotApprovalReason(input.reason);
  const approval = createApprovalEvent(approvalReason);
  const stateAfter = input.state ?? run.state;
  const updated: RunRecord = {
    ...base,
    updatedAt: nowIso(),
    ...(input.state ? { state: input.state } : {}),
    approvalRequired: false,
    approvalEvents: [...run.approvalEvents, approval],
    handoffs: [
      ...(run.handoffs ?? []),
      createRunHandoff(run, {
        kind: "approval_auto_approved",
        reason: approvalReason,
        stateAfter,
        toRole: input.role,
        gate: input.gate,
        approvalEventId: approval.id,
        artifactRefs: input.artifactRefs
      })
    ],
    events: [
      ...run.events,
      createEvent("approval_auto_approved", approvalReason, {
        gate: input.gate,
        gateReason: input.reason,
        policyDecision: "auto_approve",
        policyReason: autopilotPolicyReason(input.gate),
        ...(input.data ?? {})
      })
    ]
  };

  await saveRun(updated);
  return updated;
};

const autoApproveGateIfEnabled = async (
  run: RunRecord,
  input: {
    gate: string;
    reason: string;
    state?: RunState;
    role?: RuntimeRole;
    data?: JsonObject;
    artifactRefs?: string[];
  }
): Promise<RunRecord | undefined> => {
  const config = await loadConfig(run.repoPath);

  return isAutopilotEnabled(config) ? autoApproveGate(run, input) : undefined;
};

const approvalGateHandoff = (
  run: RunRecord,
  input: {
    reason: string;
    role?: RuntimeRole;
    gate: string;
    artifactRefs?: string[];
  }
): RunHandoffEvent =>
  createRunHandoff(run, {
    kind: "approval_gate",
    reason: input.reason,
    stateAfter: "awaiting_approval",
    fromRole: input.role,
    gate: input.gate,
    artifactRefs: input.artifactRefs
  });

const agentHandoff = (
  run: RunRecord,
  input: {
    reason: string;
    stateAfter: RunState;
    fromRole?: RuntimeRole;
    toRole?: RuntimeRole;
    artifactRefs?: string[];
  }
): RunHandoffEvent =>
  createRunHandoff(run, {
    kind: "agent_handoff",
    reason: input.reason,
    stateAfter: input.stateAfter,
    fromRole: input.fromRole,
    toRole: input.toRole,
    artifactRefs: input.artifactRefs
  });

const completionHandoff = (
  run: RunRecord,
  role: RuntimeRole,
  reason: string
): RunHandoffEvent =>
  createRunHandoff(run, {
    kind: "completion",
    reason,
    stateAfter: "completed",
    fromRole: role
  });

const updateRun = async (
  run: RunRecord,
  updates: Partial<Pick<RunRecord, "state" | "approvalRequired" | "approvalReason" | "stopReason">>,
  events: RunEvent[],
  handoffs: RunHandoffEvent[] = []
): Promise<RunRecord> => {
  const { approvalReason: _approvalReason, stopReason: _stopReason, ...base } = run;
  const next: RunRecord = {
    ...base,
    ...updates,
    updatedAt: nowIso(),
    handoffs: [...(run.handoffs ?? []), ...handoffs],
    events: [...run.events, ...events]
  };

  if (updates.approvalReason === undefined && run.approvalReason && !("approvalReason" in updates)) {
    next.approvalReason = run.approvalReason;
  }

  if (updates.stopReason === undefined && run.stopReason && !("stopReason" in updates)) {
    next.stopReason = run.stopReason;
  }

  await saveRun(next);
  return next;
};

const terminalStates = new Set<RunState>(["completed", "failed", "aborted"]);
const providerCallStates = new Set<RunState>(["created", "planning", "delegating", "implementing", "verifying"]);

const providerResponseCount = (run: RunRecord): number =>
  run.events.filter((event) => event.type === "agent_response").length;

const stopForMaxIterations = async (
  run: RunRecord
): Promise<{ run: RunRecord; stopReason: string } | undefined> => {
  if (!providerCallStates.has(run.state)) {
    return undefined;
  }

  const iterationCount = providerResponseCount(run);
  if (iterationCount < run.maxIterations) {
    return undefined;
  }

  const stopReason = `Max iterations reached (${iterationCount}/${run.maxIterations}).`;
  const failed = await updateRun(
    run,
    {
      state: "failed",
      approvalRequired: false,
      stopReason
    },
    [
      createEvent("run_failed", stopReason, {
        reason: "max_iterations",
        iterationCount,
        maxIterations: run.maxIterations
      })
    ]
  );

  return {
    run: failed,
    stopReason
  };
};

const verdictFromResponse = (response: AgentResponse): string | undefined => {
  const value = response.data.verificationResult;

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const verdict = value.verdict;
    return typeof verdict === "string" ? verdict : undefined;
  }

  return undefined;
};

const decisionFromResponse = (response: AgentResponse): JsonObject | undefined => {
  const value = response.data.decision;
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
};

const actionFromResponse = (response: AgentResponse): string | undefined => {
  const action = decisionFromResponse(response)?.action;
  return typeof action === "string" ? action : undefined;
};

const decisionStringField = (decision: JsonObject | undefined, field: string): string | undefined => {
  const value = decision?.[field];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

const decisionBooleanField = (decision: JsonObject | undefined, field: string): boolean | undefined => {
  const value = decision?.[field];
  return typeof value === "boolean" ? value : undefined;
};

const runtimeRoleFromDecisionField = (
  decision: JsonObject | undefined,
  field: string
): RuntimeRole | undefined => {
  const value = decisionStringField(decision, field);
  return value && runtimeRoles.includes(value as RuntimeRole) ? value as RuntimeRole : undefined;
};

const readyDelegateRole = (decision: JsonObject | undefined): RuntimeRole | undefined => {
  const role = runtimeRoleFromDecisionField(decision, "delegateTo") ??
    runtimeRoleFromDecisionField(decision, "nextRole");

  if (!role) {
    return undefined;
  }

  return decisionBooleanField(decision, "requiresMoreEvidence") === true ? undefined : role;
};

const readOnlyDelegateRoles = new Set<RuntimeRole>([
  "orchestrator",
  "planner",
  "researcher",
  "qa",
  "verifier",
  "critic",
  "citation"
]);

const providersRequiringRepoContextApproval = new Set(["chatgpt-web", "openai-api", "anthropic-api"]);
const readOnlyProvidersRequiringInvocationApproval = new Set([
  "anthropic-api",
  "chatgpt-web",
  "claude-code",
  "codex-cli",
  "openai-api"
]);

const latestRepoContextCapturedAt = (run: RunRecord): string | undefined =>
  run.events.filter((event) => event.type === "repo_context_captured").at(-1)?.createdAt;

const approvalMentionsRepoContextShare = (reason: string, assignment: RoleAssignment): boolean => {
  const normalized = reason.toLowerCase();
  const providerTokens = [
    assignment.provider,
    assignment.provider.replace(/-/g, " "),
    assignment.model,
    assignment.model.replace(/-/g, " ")
  ];

  return (
    normalized.includes("repo context") &&
    (normalized.includes("send") || normalized.includes("share")) &&
    providerTokens.some((token) => token && normalized.includes(token.toLowerCase()))
  );
};

const hasExternalRepoContextApproval = (run: RunRecord, assignment: RoleAssignment): boolean => {
  const capturedAt = latestRepoContextCapturedAt(run);

  return run.approvalEvents.some(
    (approval) =>
      approval.decision === "approve" &&
      (!capturedAt || approval.createdAt >= capturedAt) &&
      approvalMentionsRepoContextShare(approval.reason, assignment)
  );
};

const approvalMentionsProviderInvocation = (reason: string, assignment: RoleAssignment): boolean => {
  const normalized = reason.toLowerCase();
  const providerTokens = [
    assignment.provider,
    assignment.provider.replace(/-/g, " "),
    assignment.model,
    assignment.model.replace(/-/g, " ")
  ];

  return (
    (normalized.includes("invoke") || normalized.includes("call") || normalized.includes("use")) &&
    providerTokens.some((token) => token && normalized.includes(token.toLowerCase()))
  );
};

const hasProviderInvocationApproval = (run: RunRecord, assignment: RoleAssignment): boolean =>
  run.approvalEvents.some(
    (approval) => approval.decision === "approve" && approvalMentionsProviderInvocation(approval.reason, assignment)
  );

const hasProviderResponded = (run: RunRecord, role: RuntimeRole, assignment: RoleAssignment): boolean =>
  run.events.some((event) => {
    if (event.type !== "agent_response" || !event.data) {
      return false;
    }

    return event.data.role === role && event.data.provider === assignment.provider && event.data.model === assignment.model;
  });

const providerResponseEventMatches = (
  event: RunEvent,
  role: RuntimeRole,
  assignment?: RoleAssignment
): boolean => {
  if (event.type !== "agent_response" || !event.data || event.data.role !== role) {
    return false;
  }

  return assignment
    ? event.data.provider === assignment.provider && event.data.model === assignment.model
    : true;
};

const latestProviderResponseEventIndex = (
  run: RunRecord,
  role: RuntimeRole,
  assignment?: RoleAssignment
): number | undefined => {
  for (let index = run.events.length - 1; index >= 0; index -= 1) {
    const event = run.events[index];
    if (event && providerResponseEventMatches(event, role, assignment)) {
      return index;
    }
  }

  return undefined;
};

const hasProviderRespondedSince = (
  run: RunRecord,
  role: RuntimeRole,
  assignment: RoleAssignment,
  afterIndex: number | undefined
): boolean => {
  if (afterIndex === undefined) {
    return hasProviderResponded(run, role, assignment);
  }

  return run.events
    .slice(afterIndex + 1)
    .some((event) => providerResponseEventMatches(event, role, assignment));
};

const providerInvocationApprovalReason = (role: RuntimeRole, assignment: RoleAssignment): string =>
  `Invoking ${assignment.provider}:${assignment.model} for ${role} requires explicit approval. ` +
  `Approval message must mention "invoke ${assignment.provider}".`;

const externalRepoContextApprovalReason = (
  role: RuntimeRole,
  assignment: RoleAssignment,
  artifactSummary: string,
  approvalPhrase: string
): string =>
  `Sending repo context to ${assignment.provider}:${assignment.model} for ${role} requires explicit approval. ` +
  `Approval message must mention "${approvalPhrase}". Review the transfer manifest before approving. ` +
  `Context artifact: ${artifactSummary}`;

const createApprovalGateResponse = (role: RuntimeRole, summary: string): AgentResponse => {
  const dataForRole = (): JsonObject => {
    switch (role) {
      case "orchestrator":
      case "planner":
        return {
          decision: {
            action: "request_approval",
            reason: summary
          }
        };
      case "researcher":
        return {
          researchResult: {
            status: "blocked",
            summary,
            findings: [],
            sources: []
          }
        };
      case "critic":
        return {
          critiqueResult: {
            verdict: "unclear",
            blockingConcerns: [summary],
            nonBlockingConcerns: []
          }
        };
      case "qa":
        return {
          qaResult: {
            verdict: "blocked",
            summary,
            suggestedCommands: [],
            risks: [summary]
          }
        };
      case "verifier":
        return {
          verificationResult: {
            verdict: "ask_user",
            summary
          }
        };
      case "implementer":
        return {
          implementationResult: {
            status: "blocked",
            changedFiles: [],
            commandsRun: [],
            unresolvedRisks: [summary]
          }
        };
      default:
        return {
          result: {
            status: "blocked",
            summary
          }
        };
    }
  };

  return {
    status: "blocked",
    summary,
    data: dataForRole()
  };
};

const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const implementationPatchArtifact = (response: AgentResponse): RunArtifact | undefined => {
  const implementationResult = response.data.implementationResult;

  if (!isJsonObject(implementationResult)) {
    return undefined;
  }

  const patchArtifact = implementationResult.patchArtifact;

  if (!isJsonObject(patchArtifact)) {
    return undefined;
  }

  if (
    patchArtifact.kind !== "diff" ||
    typeof patchArtifact.ref !== "string" ||
    typeof patchArtifact.summary !== "string"
  ) {
    return undefined;
  }

  return {
    kind: "diff",
    ref: patchArtifact.ref,
    summary: patchArtifact.summary
  };
};

const isolatedPatchApprovalReason = (artifact: RunArtifact): string =>
  `Implementer produced an isolated patch artifact. Review it before applying to the target checkout. ` +
  `Approval message must mention "apply isolated patch". Patch artifact: ${artifact.summary}`;

const latestIsolatedPatchArtifact = (run: RunRecord): RunArtifact | undefined => {
  const event = run.events
    .filter((candidate) =>
      (candidate.type === "approval_required" && candidate.data?.reason === "isolated_patch_application") ||
      (candidate.type === "approval_auto_approved" && candidate.data?.gate === "isolated_patch_application")
    )
    .at(-1);
  const artifactRef = event?.data?.artifactRef;

  if (typeof artifactRef !== "string") {
    return undefined;
  }

  return run.artifacts.find((artifact) => artifact.ref === artifactRef && artifact.kind === "diff");
};

const patchBodyFromArtifact = async (artifact: RunArtifact): Promise<string> => {
  const raw = await fs.readFile(artifact.ref, "utf8");
  const markerIndex = raw.indexOf("diff --git ");

  if (markerIndex < 0) {
    throw new Error(`Patch artifact does not contain a git diff: ${artifact.ref}`);
  }

  return raw.slice(markerIndex);
};

const attachRunArtifact = async (
  run: RunRecord,
  artifact: RunArtifact,
  event: RunEvent
): Promise<RunRecord> => {
  const latest = await loadRun(run.repoPath, run.runId);
  const updated: RunRecord = {
    ...latest,
    updatedAt: nowIso(),
    artifacts: [...latest.artifacts, artifact],
    events: [...latest.events, event]
  };

  await saveRun(updated);
  return updated;
};

const artifactKindCounts = (artifacts: RunArtifact[]): JsonObject => {
  const counts: Record<string, number> = {};

  for (const artifact of artifacts) {
    counts[artifact.kind] = (counts[artifact.kind] ?? 0) + 1;
  }

  return counts;
};

const latestProviderResponseArtifactRef = (run: RunRecord, role: RuntimeRole): string | undefined => {
  const event = run.events
    .filter((candidate) => candidate.type === "agent_response" && candidate.data?.role === role)
    .at(-1);
  const artifactRef = event?.data?.artifactRef;

  return typeof artifactRef === "string" ? artifactRef : undefined;
};

const latestCriticTriggerArtifact = (run: RunRecord): RunArtifact | undefined =>
  run.artifacts.filter((artifact) => artifact.kind === "critic_trigger").at(-1);

const latestRevisionPacketArtifact = (run: RunRecord): RunArtifact | undefined =>
  run.artifacts.filter((artifact) => artifact.kind === "revision_packet").at(-1);

const writeReviewRoutingArtifact = async (
  run: RunRecord,
  decision: ReviewRoutingDecision
): Promise<{ run: RunRecord; artifact: RunArtifact }> => {
  const artifact = await writeRunArtifact({
    repoPath: run.repoPath,
    runId: run.runId,
    kind: "review_routing",
    name: `review-routing-${newId("review-routing")}.json`,
    content: `${JSON.stringify(
      {
        ...reviewRoutingJson(decision),
        runId: run.runId,
        createdAt: nowIso()
      },
      null,
      2
    )}\n`,
    summary: reviewRoutingSummary(decision)
  });
  const runWithArtifact = await attachRunArtifact(
    run,
    artifact,
    createEvent("review_routing_decided", artifact.summary, {
      artifactRef: artifact.ref,
      riskTier: decision.riskTier,
      action: decision.action,
      required: decision.required,
      reasons: decision.reasons,
      signals: decision.signals as unknown as JsonObject
    })
  );

  return {
    run: runWithArtifact,
    artifact
  };
};

const writeCriticTriggerArtifact = async (
  run: RunRecord,
  decision: CriticTriggerDecision,
  criticResponseRef: string | undefined
): Promise<RunRecord> => {
  const artifact = await writeRunArtifact({
    repoPath: run.repoPath,
    runId: run.runId,
    kind: "critic_trigger",
    name: `critic-trigger-${newId("critic-trigger")}.json`,
    content: `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "critic_trigger",
        runId: run.runId,
        called: true,
        reasonCode: decision.reasonCode,
        reason: decision.reason,
        sourceRoles: decision.sourceRoles,
        evidenceRefs: decision.evidenceRefs,
        ...(criticResponseRef ? { criticResponseRef } : {})
      },
      null,
      2
    )}\n`,
    summary: `Critic trigger: ${decision.reasonCode ?? "unknown"}`
  });

  return attachRunArtifact(
    run,
    artifact,
    createEvent("critic_trigger_written", decision.reason ?? "Runtime called critic from policy.", {
      artifactRef: artifact.ref,
      ...(decision.reasonCode ? { reasonCode: decision.reasonCode } : {}),
      sourceRoles: decision.sourceRoles,
      evidenceRefs: decision.evidenceRefs,
      ...(criticResponseRef ? { criticResponseRef } : {})
    })
  );
};

const latestRevisionPacketContext = async (run: RunRecord): Promise<JsonObject | undefined> => {
  const artifact = latestRevisionPacketArtifact(run);

  if (!artifact) {
    return undefined;
  }

  const parsed = JSON.parse(await fs.readFile(artifact.ref, "utf8")) as unknown;
  if (!isJsonObject(parsed)) {
    return undefined;
  }

  return parsed;
};

const writeAndDelegateRevision = async (
  run: RunRecord,
  input: {
    decision: RevisionPacketDecision;
    response: AgentResponse;
    evidenceRefs: string[];
    sourceResponseRef?: string;
    criticTriggerRef?: string;
  }
): Promise<{ run: RunRecord; response: AgentResponse; advanced: true; stopReason: string }> => {
  const { artifact, packet } = await writeRevisionPacketArtifact(run, input);
  const runWithPacket = await attachRunArtifact(
    run,
    artifact,
    createEvent("revision_packet_written", `Wrote revision packet from ${packet.sourceRole}.`, {
      artifactRef: artifact.ref,
      sourceRole: packet.sourceRole,
      reasonCode: packet.reasonCode,
      evidenceRefs: packet.evidenceRefs,
      ...(packet.sourceResponseRef ? { sourceResponseRef: packet.sourceResponseRef } : {}),
      ...(packet.criticTriggerRef ? { criticTriggerRef: packet.criticTriggerRef } : {})
    })
  );
  const stopReason = `Revision delegated to implementer: ${packet.reasonCode}.`;
  const { approvalReason: _approvalReason, ...runForDelegation } = runWithPacket;
  const delegated = await updateRun(
    runForDelegation,
    {
      state: "implementing",
      approvalRequired: false
    },
    [
      createEvent("revision_delegated", stopReason, {
        artifactRef: artifact.ref,
        sourceRole: packet.sourceRole,
        reasonCode: packet.reasonCode,
        repairObjective: packet.repairObjective
      })
    ],
    [agentHandoff(runWithPacket, {
      reason: stopReason,
      stateAfter: "implementing",
      fromRole: packet.sourceRole,
      toRole: "implementer",
      artifactRefs: [artifact.ref]
    })]
  );

  return {
    run: delegated,
    response: input.response,
    advanced: true,
    stopReason
  };
};

const critiqueResultFromResponse = (response: AgentResponse): JsonObject | undefined =>
  isJsonObject(response.data.critiqueResult) ? response.data.critiqueResult : undefined;

const stringArrayField = (value: JsonValue | undefined): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

const criticSafetyGateReason = (response: AgentResponse): string | undefined => {
  const critique = critiqueResultFromResponse(response);
  const verdict = typeof critique?.verdict === "string" ? critique.verdict : undefined;
  const blockingConcerns = stringArrayField(critique?.blockingConcerns);

  if (verdict === "unsafe") {
    return "Critic returned unsafe; user review is required before revision or verification can continue.";
  }

  if (verdict === "unclear" && blockingConcerns.length > 0) {
    return "Critic returned unclear with blocking concerns; user review is required before revision or verification can continue.";
  }

  return undefined;
};

const stopForCriticSafetyGate = async (
  run: RunRecord,
  response: AgentResponse
): Promise<{ run: RunRecord; response: AgentResponse; advanced: true; stopReason: string } | undefined> => {
  const approvalReason = criticSafetyGateReason(response);

  if (!approvalReason) {
    return undefined;
  }

  const criticResponseRef = latestProviderResponseArtifactRef(run, "critic");
  const gated = await updateRun(
    run,
    {
      state: "awaiting_approval",
      approvalRequired: true,
      approvalReason
    },
    [
      createEvent("approval_required", approvalReason, {
        reason: "critic_safety_review",
        ...(criticResponseRef ? { artifactRef: criticResponseRef } : {})
      })
    ],
    [approvalGateHandoff(run, {
      reason: approvalReason,
      role: "critic",
      gate: "critic_safety_review",
      artifactRefs: criticResponseRef ? [criticResponseRef] : []
    })]
  );

  return {
    run: gated,
    response,
    advanced: true,
    stopReason: approvalReason
  };
};

const writeFinalReport = async (
  run: RunRecord,
  input: {
    role: RuntimeRole;
    response: AgentResponse;
    stopReason: string;
  }
): Promise<RunRecord> => {
  const latest = await loadRun(run.repoPath, run.runId);
  const reportArtifact = await writeRunArtifact({
    repoPath: latest.repoPath,
    runId: latest.runId,
    kind: "report",
    name: `final-${newId("report")}.json`,
    content: `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "final_report",
        runId: latest.runId,
        repoPath: latest.repoPath,
        goal: latest.userGoal,
        mode: latest.mode,
        finalState: "completed",
        stopReason: input.stopReason,
        completedBy: {
          role: input.role,
          responseStatus: input.response.status,
          responseSummary: input.response.summary
        },
        roleMapping: latest.roleMapping,
        artifactCounts: artifactKindCounts(latest.artifacts),
        artifacts: latest.artifacts.map((artifact) => ({
          kind: artifact.kind,
          ref: artifact.ref,
          summary: artifact.summary
        })),
        toolEvents: latest.toolEvents.map((event) => ({
          id: event.id,
          tool: event.tool,
          command: event.command,
          args: event.args,
          cwd: event.cwd,
          exitCode: event.exitCode,
          safetyCategory: event.safetyCategory,
          stdoutRef: event.stdoutRef,
          stderrRef: event.stderrRef
        })),
        approvalEvents: latest.approvalEvents.map((event) => ({
          id: event.id,
          decision: event.decision,
          reason: event.reason
        })),
        ...(latestCriticTriggerArtifact(latest)
          ? { criticTrigger: latestCriticTriggerArtifact(latest) }
          : {}),
        crewLanes: deriveCrewLaneTrail(latest).lanes,
        revisionTrail: deriveRevisionTrail(latest).items,
        reviewLanes: deriveReviewLanes(latest)
      },
      null,
      2
    )}\n`,
    summary: `Final report for completed ${latest.mode} run.`
  });

  return attachRunArtifact(
    latest,
    reportArtifact,
    createEvent("final_report_written", "Wrote runtime final report.", {
      artifactRef: reportArtifact.ref,
      role: input.role,
      responseStatus: input.response.status
    })
  );
};

const protectedPatchApprovalReason = (protectedChanges: ProtectedPathMatch[]): string =>
  `Applied patch changed ${protectedChanges.length} protected test, fixture, snapshot, or eval path(s). ` +
  `Review before verification. Approval message must mention "protected test changes".`;

const writeIntegrationReport = async (
  run: RunRecord,
  sourceArtifact: RunArtifact,
  approvedPatchArtifact: RunArtifact,
  applyEvent: ToolEvent,
  statusEvent: ToolEvent,
  changedPaths: string[],
  protectedChanges: ProtectedPathMatch[]
): Promise<RunRecord> => {
  const reportArtifact = await writeRunArtifact({
    repoPath: run.repoPath,
    runId: run.runId,
    kind: "report",
    name: `integration-${newId("report")}.json`,
    content: `${JSON.stringify(
      {
        runId: run.runId,
        sourceArtifactRef: sourceArtifact.ref,
        sourceArtifactSummary: sourceArtifact.summary,
        approvedPatchArtifactRef: approvedPatchArtifact.ref,
        approvedPatchArtifactSummary: approvedPatchArtifact.summary,
        applyToolEventId: applyEvent.id,
        applyExitCode: applyEvent.exitCode,
        applyStdoutRef: applyEvent.stdoutRef,
        applyStderrRef: applyEvent.stderrRef,
        postApplyStatusToolEventId: statusEvent.id,
        postApplyStatusRef: statusEvent.stdoutRef,
        changedPaths,
        protectedChanges,
        protectedChangeCount: protectedChanges.length
      },
      null,
      2
    )}\n`,
    summary: `Integration report for ${changedPaths.length} changed path(s), ${protectedChanges.length} protected.`
  });

  return attachRunArtifact(
    run,
    reportArtifact,
    createEvent("integration_report_written", "Wrote runtime integration report.", {
      artifactRef: reportArtifact.ref,
      changedPathCount: changedPaths.length,
      protectedChangeCount: protectedChanges.length
    })
  );
};

const applyIsolatedPatchArtifact = async (run: RunRecord): Promise<{ run: RunRecord; stopReason?: string }> => {
  const artifact = latestIsolatedPatchArtifact(run);

  if (!artifact) {
    const stopReason = "No isolated patch artifact is available for integration.";
    const failed = await updateRun(
      run,
      {
        state: "failed",
        approvalRequired: false,
        stopReason
      },
      [createEvent("run_failed", stopReason)]
    );

    return {
      run: failed,
      stopReason
    };
  }

  const status = await runRuntimeCommand({
    repoPath: run.repoPath,
    runId: run.runId,
    tool: "pre_apply_git_status",
    command: "git",
    args: ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).thehood"]
  });

  if (status.stdout.trim()) {
    const approvalReason = "Target checkout must be clean before applying isolated patch artifact.";
    const gated = await updateRun(
      status.run,
      {
        state: "awaiting_approval",
        approvalRequired: true,
        approvalReason
      },
      [createEvent("approval_required", approvalReason)],
      [approvalGateHandoff(status.run, {
        reason: approvalReason,
        role: "integrator",
        gate: "dirty_checkout_before_patch"
      })]
    );

    return {
      run: gated,
      stopReason: approvalReason
    };
  }

  const patchBody = await patchBodyFromArtifact(artifact);
  const patchInput = await writeRunArtifact({
    repoPath: run.repoPath,
    runId: run.runId,
    kind: "diff",
    name: `approved-${newId("patch")}.patch`,
    content: patchBody,
    summary: `Approved isolated patch body from ${artifact.summary}`
  });
  const runWithPatchInput = await attachRunArtifact(
    status.run,
    patchInput,
    createEvent("integration_patch_prepared", "Prepared isolated patch for target checkout application.", {
      sourceArtifactRef: artifact.ref,
      patchArtifactRef: patchInput.ref
    })
  );
  const applied = await runRuntimeCommand({
    repoPath: runWithPatchInput.repoPath,
    runId: runWithPatchInput.runId,
    tool: "git_apply_patch",
    command: "git",
    args: ["apply", "--whitespace=nowarn", patchInput.ref]
  });

  if (applied.event.exitCode !== 0) {
    const stopReason = "Applying isolated patch artifact failed.";
    const failed = await updateRun(
      applied.run,
      {
        state: "failed",
        approvalRequired: false,
        stopReason
      },
      [createEvent("run_failed", stopReason)]
    );

    return {
      run: failed,
      stopReason
    };
  }

  const postApplyStatus = await runRuntimeCommand({
    repoPath: applied.run.repoPath,
    runId: applied.run.runId,
    tool: "post_apply_git_status",
    command: "git",
    args: ["status", "--short", "--untracked-files=all", "--", ".", ":(exclude).thehood"]
  });
  const changedPaths = parseGitStatusPaths(postApplyStatus.stdout);
  const config = await loadConfig(postApplyStatus.run.repoPath);
  const protectedChanges = findProtectedPathMatches(changedPaths, config.defaults.protectedTestPaths);
  const runWithReport = await writeIntegrationReport(
    postApplyStatus.run,
    artifact,
    patchInput,
    applied.event,
    postApplyStatus.event,
    changedPaths,
    protectedChanges
  );

  if (protectedChanges.length > 0) {
    const approvalReason = protectedPatchApprovalReason(protectedChanges);
    const protectedChangesData = protectedChanges.map((match) => ({
      path: match.path,
      pattern: match.pattern
    }));
    const gated = await updateRun(
      runWithReport,
      {
        state: "awaiting_approval",
        approvalRequired: true,
        approvalReason
      },
      [
        createEvent("patch_applied", "Applied isolated patch artifact to target checkout.", {
          sourceArtifactRef: artifact.ref,
          patchArtifactRef: patchInput.ref
        }),
        createEvent("approval_required", approvalReason, {
          reason: "protected_patch_changes",
          protectedChangeCount: protectedChanges.length,
          protectedChanges: protectedChangesData
        })
      ],
      [approvalGateHandoff(runWithReport, {
        reason: approvalReason,
        role: "integrator",
        gate: "protected_patch_changes",
        artifactRefs: [artifact.ref, patchInput.ref]
      })]
    );

    return {
      run: gated,
      stopReason: approvalReason
    };
  }

  const verifying = await updateRun(
    runWithReport,
    { state: "verifying" },
    [
      createEvent("patch_applied", "Applied isolated patch artifact to target checkout.", {
        sourceArtifactRef: artifact.ref,
        patchArtifactRef: patchInput.ref
      }),
      createEvent("state_changed", "Run entered verification.")
    ],
    [agentHandoff(runWithReport, {
      reason: "Integrated patch moved to independent verification.",
      stateAfter: "verifying",
      fromRole: "integrator",
      toRole: "verifier",
      artifactRefs: [artifact.ref, patchInput.ref]
    })]
  );

  return {
    run: verifying
  };
};

const stopForProviderInvocationApproval = async (
  run: RunRecord,
  role: RuntimeRole,
  assignment: RoleAssignment
): Promise<{ run: RunRecord; gated: boolean; response?: AgentResponse; stopReason?: string } | undefined> => {
  if (
    !readOnlyProvidersRequiringInvocationApproval.has(assignment.provider) ||
    hasProviderResponded(run, role, assignment) ||
    hasProviderInvocationApproval(run, assignment)
  ) {
    return undefined;
  }

  const approvalReason = providerInvocationApprovalReason(role, assignment);
  const autoApproved = await autoApproveGateIfEnabled(run, {
    gate: "provider_invocation",
    reason: approvalReason,
    role,
    data: {
      role,
      provider: assignment.provider,
      model: assignment.model
    }
  });

  if (autoApproved) {
    return {
      run: autoApproved,
      gated: false
    };
  }

  const gated = await updateRun(
    run,
    {
      state: "awaiting_approval",
      approvalRequired: true,
      approvalReason
    },
    [
      createEvent("approval_required", approvalReason, {
        role,
        provider: assignment.provider,
        model: assignment.model,
        reason: "provider_invocation"
      })
    ],
    [approvalGateHandoff(run, {
      reason: approvalReason,
      role,
      gate: "provider_invocation"
    })]
  );

  return {
    run: gated,
    gated: true,
    response: createApprovalGateResponse(role, approvalReason),
    stopReason: approvalReason
  };
};

const stopForProviderStatus = async (
  run: RunRecord,
  role: RuntimeRole,
  response: AgentResponse
): Promise<{ run: RunRecord; stopReason: string } | undefined> => {
  if (response.status === "ok") {
    return undefined;
  }

  const stopReason = `${role} returned ${response.status}: ${response.summary}`;

  if (response.status === "blocked") {
    const blocked = await updateRun(
      run,
      {
        state: "awaiting_approval",
        approvalRequired: true,
        approvalReason: stopReason
      },
      [createEvent("approval_required", stopReason)],
      [approvalGateHandoff(run, {
        reason: stopReason,
        role,
        gate: "provider_blocked"
      })]
    );

    return {
      run: blocked,
      stopReason
    };
  }

  const failed = await updateRun(
    run,
    {
      state: "failed",
      approvalRequired: false,
      stopReason
    },
    [createEvent("run_failed", stopReason)]
  );

  return {
    run: failed,
    stopReason
  };
};

const runCriticForTrigger = async (
  run: RunRecord,
  decision: CriticTriggerDecision
): Promise<{ run: RunRecord; response?: AgentResponse; advanced: boolean; stopReason?: string } | undefined> => {
  if (!decision.callCritic || !decision.reasonCode || !decision.reason) {
    return undefined;
  }

  const assignment = run.roleMapping.critic;
  const implementationResponseIndex = latestProviderResponseEventIndex(run, "implementer");
  if (!assignment || hasProviderRespondedSince(run, "critic", assignment, implementationResponseIndex)) {
    return undefined;
  }

  let criticRun = run;
  const invocationGate = await stopForProviderInvocationApproval(criticRun, "critic", assignment);

  if (invocationGate) {
    criticRun = invocationGate.run;
  }

  if (invocationGate?.gated && invocationGate.response && invocationGate.stopReason) {
    return {
      run: invocationGate.run,
      response: invocationGate.response,
      advanced: true,
      stopReason: invocationGate.stopReason
    };
  }

  const result = await runAgent(criticRun, "critic", {
    phase: "critique",
    criticTrigger: {
      reasonCode: decision.reasonCode,
      reason: decision.reason,
      sourceRoles: decision.sourceRoles,
      evidenceRefs: decision.evidenceRefs
    }
  });
  const criticResponseRef = latestProviderResponseArtifactRef(result.run, "critic");
  const runWithTrigger = await writeCriticTriggerArtifact(result.run, decision, criticResponseRef);
  const stopped = await stopForProviderStatus(runWithTrigger, "critic", result.response);

  if (stopped) {
    return {
      run: stopped.run,
      response: result.response,
      advanced: true,
      stopReason: stopped.stopReason
    };
  }

  const runWithHandoff = await updateRun(
    runWithTrigger,
    { state: "verifying" },
    [createEvent("critic_completed", "Critic reviewed runtime-triggered risk evidence.")],
    [agentHandoff(runWithTrigger, {
      reason: decision.reason,
      stateAfter: "verifying",
      toRole: "critic",
      ...(decision.sourceRoles[0] ? { fromRole: decision.sourceRoles[0] } : {}),
      artifactRefs: criticResponseRef ? [criticResponseRef] : []
    })]
  );

  return {
    run: runWithHandoff,
    response: result.response,
    advanced: true
  };
};

const readOnlyRoleForMode = (run: RunRecord): RuntimeRole => {
  if (run.preferredRole && run.roleMapping[run.preferredRole]) {
    return run.preferredRole;
  }

  if (run.mode === "review" && run.roleMapping.critic) {
    return "critic";
  }

  if (run.mode === "research" && run.roleMapping.researcher) {
    return "researcher";
  }

  if (run.mode === "plan" && run.roleMapping.planner) {
    return "planner";
  }

  return "orchestrator";
};

const readOnlyContext = async (run: RunRecord): Promise<JsonObject> => {
  const repoContext = await readCombinedRepoContext(run);
  const contextArtifact = latestRepoContextArtifact(run);
  const contextArtifacts = repoContextArtifacts(run);
  const remoteRepoContext = await readLatestRemoteRepoContext(run);
  const remoteContextArtifact = latestRemoteRepoContextArtifact(run);
  const remoteContextArtifacts = remoteRepoContextArtifacts(run);

  return {
    phase: run.mode,
    ...(repoContext ? { repoContext: repoContext as unknown as JsonObject } : {}),
    ...(remoteRepoContext ? { remoteRepoContext: remoteRepoContext as unknown as JsonObject } : {}),
    ...(contextArtifact
      ? {
          repoContextArtifact: {
            kind: contextArtifact.kind,
            ref: contextArtifact.ref,
            summary: contextArtifact.summary
          }
        }
      : {}),
    ...(contextArtifacts.length > 0
      ? {
          repoContextArtifacts: contextArtifacts.map((artifact) => ({
            kind: artifact.kind,
            ref: artifact.ref,
            summary: artifact.summary
          }))
        }
      : {}),
    ...(remoteContextArtifact
      ? {
          remoteRepoContextArtifact: {
            kind: remoteContextArtifact.kind,
            ref: remoteContextArtifact.ref,
            summary: remoteContextArtifact.summary
          }
        }
      : {}),
    ...(remoteContextArtifacts.length > 0
      ? {
          remoteRepoContextArtifacts: remoteContextArtifacts.map((artifact) => ({
            kind: artifact.kind,
            ref: artifact.ref,
            summary: artifact.summary
          }))
        }
      : {})
  };
};

const completeReadOnlyRun = async (
  run: RunRecord,
  input: {
    role: RuntimeRole;
    response: AgentResponse;
    stopReason: string;
    eventMessage: string;
    handoffReason?: string;
    eventData?: JsonObject;
  }
): Promise<{ run: RunRecord; response: AgentResponse; advanced: true }> => {
  const runWithFinalReport = await writeFinalReport(run, {
    role: input.role,
    response: input.response,
    stopReason: input.stopReason
  });
  const completed = await updateRun(
    runWithFinalReport,
    { state: "completed", stopReason: input.stopReason },
    [createEvent("run_completed", input.eventMessage, input.eventData)],
    [completionHandoff(runWithFinalReport, input.role, input.handoffReason ?? input.stopReason)]
  );
  const progress = await writeProgressPacketArtifact(completed);

  return {
    run: progress.run,
    response: input.response,
    advanced: true
  };
};

const executeReadOnlyRun = async (
  run: RunRecord,
  role: RuntimeRole
): Promise<{ run: RunRecord; response: AgentResponse; advanced: boolean; stopReason?: string }> => {
  const assignment = requiredAssignment(run, role);
  const contextArtifact = latestRepoContextArtifact(run);
  const invocationGate = await stopForProviderInvocationApproval(run, role, assignment);

  if (invocationGate) {
    run = invocationGate.run;
  }

  if (invocationGate?.gated && invocationGate.response && invocationGate.stopReason) {
    return {
      run: invocationGate.run,
      response: invocationGate.response,
      advanced: true,
      stopReason: invocationGate.stopReason
    };
  }

  if (
    contextArtifact &&
    providersRequiringRepoContextApproval.has(assignment.provider) &&
    !hasExternalRepoContextApproval(run, assignment)
  ) {
    const approvalPhrase = `send repo context to ${assignment.provider}`;
    const transfer = await writeExternalTransferManifestArtifact({
      run,
      role,
      destination: assignment,
      purpose: "repo_context",
      approvalPhrase,
      artifacts: [contextArtifact]
    });
    const config = await loadConfig(run.repoPath);
    const policyEvaluation = evaluateExternalTransferPolicy(config, transfer.manifest);
    const approvalReason = externalRepoContextApprovalReason(role, assignment, contextArtifact.summary, approvalPhrase);
    const transferEvent = createEvent("external_transfer_manifest_written", transfer.artifact.summary, {
      role,
      provider: assignment.provider,
      model: assignment.model,
      reason: "repo_context_external_transfer",
      artifactRef: transfer.artifact.ref,
      artifactSummary: transfer.artifact.summary,
      sourceArtifactRef: contextArtifact.ref,
      sourceArtifactSummary: contextArtifact.summary,
      transfer: transferManifestSummary(transfer.manifest)
    });

    if (policyEvaluation.decision === "auto_approve") {
      const approval = createApprovalEvent(autoApprovalReason(transfer.manifest, policyEvaluation));
      run = {
        ...run,
        updatedAt: nowIso(),
        approvalRequired: false,
        artifacts: [...run.artifacts, transfer.artifact],
        approvalEvents: [...run.approvalEvents, approval],
        handoffs: [
          ...(run.handoffs ?? []),
          createRunHandoff(run, {
            kind: "approval_auto_approved",
            reason: approval.reason,
            stateAfter: run.state,
            toRole: role,
            gate: "repo_context_external_transfer",
            approvalEventId: approval.id,
            artifactRefs: [transfer.artifact.ref, contextArtifact.ref]
          })
        ],
        events: [
          ...run.events,
          transferEvent,
          createEvent("approval_auto_approved", approval.reason, {
            role,
            provider: assignment.provider,
            model: assignment.model,
            reason: "repo_context_external_transfer",
            policyDecision: policyEvaluation.decision,
            policyReason: policyEvaluation.reason,
            artifactRef: transfer.artifact.ref,
            sourceArtifactRef: contextArtifact.ref,
            transfer: transferManifestSummary(transfer.manifest)
          })
        ]
      };

      await saveRun(run);
    } else {
      const gated: RunRecord = {
        ...run,
        updatedAt: nowIso(),
        state: "awaiting_approval",
        approvalRequired: true,
        approvalReason,
        artifacts: [...run.artifacts, transfer.artifact],
        handoffs: [
          ...(run.handoffs ?? []),
          approvalGateHandoff(run, {
            reason: approvalReason,
            role,
            gate: "repo_context_external_transfer",
            artifactRefs: [transfer.artifact.ref, contextArtifact.ref]
          })
        ],
        events: [
          ...run.events,
          transferEvent,
          createEvent("approval_required", approvalReason, {
            role,
            provider: assignment.provider,
            model: assignment.model,
            reason: "repo_context_external_transfer",
            artifactRef: transfer.artifact.ref,
            artifactSummary: transfer.artifact.summary,
            sourceArtifactRef: contextArtifact.ref,
            sourceArtifactSummary: contextArtifact.summary,
            transfer: transferManifestSummary(transfer.manifest)
          })
        ]
      };

      await saveRun(gated);

      return {
        run: gated,
        response: createApprovalGateResponse(role, approvalReason),
        advanced: true,
        stopReason: approvalReason
      };
    }
  }

  const result = await runAgent(run, role, await readOnlyContext(run));
  const stopped = await stopForProviderStatus(result.run, role, result.response);

  if (stopped) {
    return {
      run: stopped.run,
      response: result.response,
      advanced: true,
      stopReason: stopped.stopReason
    };
  }

  if (actionFromResponse(result.response) === "delegate") {
    const decision = decisionFromResponse(result.response);
    const delegateRole = readyDelegateRole(decision);

    if (delegateRole) {
      const sliceName = decisionStringField(decision, "sliceName");
      const eventData: JsonObject = {
        reason: "role_handoff_delegate",
        delegateTo: delegateRole,
        requiresMoreEvidence: decisionBooleanField(decision, "requiresMoreEvidence") ?? false
      };

      if (sliceName) {
        eventData.sliceName = sliceName;
      }

      if (delegateRole === "implementer") {
        return completeReadOnlyRun(result.run, {
          role,
          response: result.response,
          stopReason: `${role} produced a ready ${delegateRole} handoff.`,
          eventMessage: `${role} produced a ready ${delegateRole} handoff.`,
          handoffReason: `${role} completed read-only planning with a ready handoff to ${delegateRole}.`,
          eventData
        });
      }

      if (readOnlyDelegateRoles.has(delegateRole)) {
        if (delegateRole === role) {
          const approvalReason = `${role} delegated back to itself.`;
          const gated = await updateRun(
            result.run,
            {
              state: "awaiting_approval",
              approvalRequired: true,
              approvalReason
            },
            [
              createEvent("approval_required", approvalReason, {
                ...eventData,
                role,
                reason: "self_read_only_delegate"
              })
            ],
            [approvalGateHandoff(result.run, {
              reason: approvalReason,
              role,
              gate: "self_read_only_delegate"
            })]
          );

          return {
            run: gated,
            response: result.response,
            advanced: true,
            stopReason: approvalReason
          };
        }

        if (!result.run.roleMapping[delegateRole]) {
          const approvalReason = `${role} delegated to ${delegateRole}, but ${delegateRole} role is not assigned.`;
          const gated = await updateRun(
            result.run,
            {
              state: "awaiting_approval",
              approvalRequired: true,
              approvalReason
            },
            [
              createEvent("approval_required", approvalReason, {
                ...eventData,
                role,
                reason: "missing_read_only_delegate_assignment"
              })
            ],
            [approvalGateHandoff(result.run, {
              reason: approvalReason,
              role,
              gate: "missing_read_only_delegate_assignment"
            })]
          );

          return {
            run: gated,
            response: result.response,
            advanced: true,
            stopReason: approvalReason
          };
        }

        const delegated = await updateRun(
          result.run,
          {
            state: "planning",
            approvalRequired: false
          },
          [
            createEvent(`${role}_delegated_read_only_role`, `${role} delegated read-only planning to ${delegateRole}.`, {
              ...eventData,
              role,
              toRole: delegateRole
            })
          ],
          [agentHandoff(result.run, {
            reason: `${role} delegated read-only planning to ${delegateRole}.`,
            stateAfter: "planning",
            fromRole: role,
            toRole: delegateRole
          })]
        );

        return executeReadOnlyRun(delegated, delegateRole);
      }

      const approvalReason = `${role} delegated to unsupported read-only role ${delegateRole}.`;
      const gated = await updateRun(
        result.run,
        {
          state: "awaiting_approval",
          approvalRequired: true,
          approvalReason
        },
        [
          createEvent("approval_required", approvalReason, {
            ...eventData,
            role,
            reason: "unsupported_read_only_delegate_role"
          })
        ],
        [approvalGateHandoff(result.run, {
          reason: approvalReason,
          role,
          gate: "unsupported_read_only_delegate_role"
        })]
      );

      return {
        run: gated,
        response: result.response,
        advanced: true,
        stopReason: approvalReason
      };
    }

    const existingContextArtifact = latestRepoContextArtifact(result.run);
    const existingRemoteContextArtifact = latestRemoteRepoContextArtifact(result.run);
    let preferredPaths: string[] = [];

    if (existingContextArtifact) {
      const analysis = await analyzeRepoContextRequest(result.run, decision);
      preferredPaths = analysis.newRequestedPaths;

      if (analysis.newRequestedPaths.length === 0) {
        const approvalReason =
          analysis.requestedPaths.length > 0
            ? `${role} requested another delegation, but all requested repo paths were already captured.`
            : `${role} requested another delegation after repo context was already captured.`;
        const gated = await updateRun(
          result.run,
          {
            state: "awaiting_approval",
            approvalRequired: true,
            approvalReason
          },
          [
            createEvent("approval_required", approvalReason, {
              role,
              reason: "repeated_repo_context_delegate",
              requestedPaths: analysis.requestedPaths,
              alreadyCapturedPaths: analysis.alreadyCapturedPaths,
              incompleteCapturedPaths: analysis.incompleteCapturedPaths,
              existingContextArtifactRef: existingContextArtifact.ref
            })
          ],
          [approvalGateHandoff(result.run, {
            reason: approvalReason,
            role,
            gate: "repeated_repo_context_delegate",
            artifactRefs: [existingContextArtifact.ref]
          })]
        );

        return {
          run: gated,
          response: result.response,
          advanced: true,
          stopReason: approvalReason
        };
      }
    }

    if (!existingContextArtifact && existingRemoteContextArtifact) {
      const approvalReason =
        `${role} requested another delegation after GitHub connector repo context was already selected.`;
      const gated = await updateRun(
        result.run,
        {
          state: "awaiting_approval",
          approvalRequired: true,
          approvalReason
        },
        [
          createEvent("approval_required", approvalReason, {
            role,
            reason: "repeated_remote_repo_context_delegate",
            existingRemoteContextArtifactRef: existingRemoteContextArtifact.ref
          })
        ],
        [approvalGateHandoff(result.run, {
          reason: approvalReason,
          role,
          gate: "repeated_remote_repo_context_delegate",
          artifactRefs: [existingRemoteContextArtifact.ref]
        })]
      );

      return {
        run: gated,
        response: result.response,
        advanced: true,
        stopReason: approvalReason
      };
    }

    if (!existingContextArtifact && !existingRemoteContextArtifact) {
      const remoteContext = await captureRemoteRepoContext(result.run, assignment, decision);

      if (remoteContext.selected) {
        return {
          run: remoteContext.run,
          response: result.response,
          advanced: true,
          stopReason: "Selected GitHub connector repo context for delegated read-only planning."
        };
      }
    }

    const repoContext = await captureRepoContext(result.run, decision, { preferredPaths });

    return {
      run: repoContext.run,
      response: result.response,
      advanced: true,
      stopReason: existingContextArtifact
        ? "Captured follow-up repo context for targeted delegated read-only planning."
        : "Captured repo context for delegated read-only planning."
    };
  }

  if (actionFromResponse(result.response) === "request_approval") {
    const decision = decisionFromResponse(result.response);
    const approvalReason =
      typeof decision?.reason === "string" ? decision.reason : `${role} requested approval.`;
    const gated = await updateRun(
      result.run,
      {
        state: "awaiting_approval",
        approvalRequired: true,
        approvalReason
      },
      [createEvent("approval_required", approvalReason)],
      [approvalGateHandoff(result.run, {
        reason: approvalReason,
        role,
        gate: "provider_requested_approval"
      })]
    );

    return {
      run: gated,
      response: result.response,
      advanced: true,
      stopReason: approvalReason
    };
  }

  const stopReason = `${role} run completed by provider response.`;
  return completeReadOnlyRun(result.run, {
    role,
    response: result.response,
    stopReason,
    eventMessage: `${role} run completed.`
  });
};

const advanceOneStep = async (
  run: RunRecord
): Promise<{ run: RunRecord; response?: AgentResponse; advanced: boolean; stopReason?: string }> => {
  if (terminalStates.has(run.state)) {
    return {
      run,
      advanced: false,
      stopReason: `Run is already ${run.state}.`
    };
  }

  if (run.approvalRequired) {
    return {
      run,
      advanced: false,
      stopReason: run.approvalReason ?? "Approval required."
    };
  }

  const maxIterationsStop = await stopForMaxIterations(run);
  if (maxIterationsStop) {
    return {
      run: maxIterationsStop.run,
      advanced: true,
      stopReason: maxIterationsStop.stopReason
    };
  }

  if (run.state === "created" && run.mode !== "implement") {
    const role = readOnlyRoleForMode(run);
    const planned = await updateRun(
      run,
      { state: "planning" },
      [createEvent("state_changed", `Run entered ${run.mode} execution with ${role}.`)],
      [agentHandoff(run, {
        reason: `Runtime selected ${role} for ${run.mode} execution.`,
        stateAfter: "planning",
        toRole: role
      })]
    );
    return executeReadOnlyRun(planned, role);
  }

  if (run.state === "planning" && run.mode !== "implement") {
    return executeReadOnlyRun(run, readOnlyRoleForMode(run));
  }

  if (run.state === "delegating") {
    const result = await runAgent(run, "orchestrator", {
      phase: "delegate"
    });
    const stopped = await stopForProviderStatus(result.run, "orchestrator", result.response);

    if (stopped) {
      return {
        run: stopped.run,
        response: result.response,
        advanced: true,
        stopReason: stopped.stopReason
      };
    }

    const next = await updateRun(
      result.run,
      { state: "implementing" },
      [createEvent("state_changed", "Run entered implementation.")],
      [agentHandoff(result.run, {
        reason: "Orchestrator delegated implementation to the implementer.",
        stateAfter: "implementing",
        fromRole: "orchestrator",
        toRole: "implementer"
      })]
    );

    return {
      run: next,
      response: result.response,
      advanced: true
    };
  }

  if (run.state === "implementing") {
    const revisionPacket = await latestRevisionPacketContext(run);
    const result = await runAgent(run, "implementer", {
      phase: "implement",
      ...(revisionPacket ? { latestRevisionPacket: revisionPacket } : {})
    });
    const stopped = await stopForProviderStatus(result.run, "implementer", result.response);

    if (stopped) {
      return {
        run: stopped.run,
        response: result.response,
        advanced: true,
        stopReason: stopped.stopReason
      };
    }

    const patchArtifact = implementationPatchArtifact(result.response);

    if (patchArtifact) {
      const approvalReason = isolatedPatchApprovalReason(patchArtifact);
      const autoApproved = await autoApproveGateIfEnabled(result.run, {
        gate: "isolated_patch_application",
        reason: approvalReason,
        state: "integrating",
        role: "integrator",
        artifactRefs: [patchArtifact.ref],
        data: {
          artifactRef: patchArtifact.ref,
          artifactSummary: patchArtifact.summary
        }
      });

      if (autoApproved) {
        return {
          run: autoApproved,
          response: result.response,
          advanced: true,
          stopReason: approvalReason
        };
      }

      const gated = await updateRun(
        result.run,
        {
          state: "awaiting_approval",
          approvalRequired: true,
          approvalReason
        },
        [
          createEvent("approval_required", approvalReason, {
            reason: "isolated_patch_application",
            artifactRef: patchArtifact.ref,
            artifactSummary: patchArtifact.summary
          })
        ],
        [approvalGateHandoff(result.run, {
          reason: approvalReason,
          role: "implementer",
          gate: "isolated_patch_application",
          artifactRefs: [patchArtifact.ref]
        })]
      );

      return {
        run: gated,
        response: result.response,
        advanced: true,
        stopReason: approvalReason
      };
    }

    const next = await updateRun(
      result.run,
      { state: "verifying" },
      [createEvent("state_changed", "Run entered verification.")],
      [agentHandoff(result.run, {
        reason: "Implementer completed work and handed off to verifier.",
        stateAfter: "verifying",
        fromRole: "implementer",
        toRole: "verifier"
      })]
    );

    return {
      run: next,
      response: result.response,
      advanced: true
    };
  }

  if (run.state === "integrating") {
    const integrated = await applyIsolatedPatchArtifact(run);

    return {
      run: integrated.run,
      advanced: true,
      stopReason: integrated.stopReason ?? "Applied isolated patch artifact."
    };
  }

  if (run.state === "verifying") {
    const evidence = await captureGitEvidence(run.repoPath, run.runId);
    const validation = await captureValidationEvidence(evidence.run);
    const implementationResponseIndex = latestProviderResponseEventIndex(validation.run, "implementer");
    const qaAssignment = validation.run.roleMapping.qa;
    const verifierAssignment = validation.run.roleMapping.verifier;
    const qaResponded = qaAssignment
      ? hasProviderRespondedSince(validation.run, "qa", qaAssignment, implementationResponseIndex)
      : false;
    const verifierResponded = verifierAssignment
      ? hasProviderRespondedSince(validation.run, "verifier", verifierAssignment, implementationResponseIndex)
      : false;
    const routingDecision = decideReviewRouting({
      changedPaths: evidence.changedPaths,
      protectedChangeCount: evidence.protectedChanges.length,
      validationCommandCount: validation.executedCommands.length,
      validationFailureCount: validation.failedCommands.length,
      hasQaAssignment: Boolean(qaAssignment),
      hasVerifierAssignment: Boolean(verifierAssignment),
      hasQaResponse: qaResponded,
      hasVerifierResponse: verifierResponded
    });
    const routing = await writeReviewRoutingArtifact(
      validation.run,
      routingDecision
    );
    const validationRun = routing.run;

    if (qaAssignment && routingDecision.action === "run_qa") {
      let qaRun = validationRun;
      const invocationGate = await stopForProviderInvocationApproval(qaRun, "qa", qaAssignment);

      if (invocationGate) {
        qaRun = invocationGate.run;
      }

      if (invocationGate?.gated && invocationGate.response && invocationGate.stopReason) {
        return {
          run: invocationGate.run,
          response: invocationGate.response,
          advanced: true,
          stopReason: invocationGate.stopReason
        };
      }

      const revisionPacket = await latestRevisionPacketContext(qaRun);
      const qaResult = await runAgent(qaRun, "qa", {
        phase: "qa",
        changedPathCount: evidence.changedPaths.length,
        protectedChangeCount: evidence.protectedChanges.length,
        validationCommandCount: validation.executedCommands.length,
        validationFailureCount: validation.failedCommands.length,
        validationSummaryRef: validation.artifact.ref,
        reviewRoutingRef: routing.artifact.ref,
        ...(revisionPacket ? { latestRevisionPacket: revisionPacket } : {})
      });
      const stopped = await stopForProviderStatus(qaResult.run, "qa", qaResult.response);

      if (stopped) {
        return {
          run: stopped.run,
          response: qaResult.response,
          advanced: true,
          stopReason: stopped.stopReason
        };
      }

      const qaCompleted = await updateRun(
        qaResult.run,
        { state: "verifying" },
        [createEvent("qa_tester_completed", "QA tester reviewed runtime evidence before verifier review.")],
        [agentHandoff(qaResult.run, {
          reason: "QA tester reviewed runtime evidence; verifier remains the required approval lane.",
          stateAfter: "verifying",
          fromRole: "qa",
          toRole: "verifier"
        })]
      );
      const qaResponseRef = latestProviderResponseArtifactRef(qaCompleted, "qa");
      const qaEvidenceRefs = [
        validation.artifact.ref,
        ...[qaResponseRef].filter((ref): ref is string => Boolean(ref))
      ];
      const qaRevision = decideRevisionPacket("qa", qaResult.response);
      const criticDecision = decideCriticTrigger({
        qaResponse: qaResult.response,
        validationFailureCount: validation.failedCommands.length,
        evidenceRefs: qaEvidenceRefs
      });
      const critic = await runCriticForTrigger(qaCompleted, criticDecision);

      if (critic) {
        if (critic.response) {
          const criticSafetyGate = await stopForCriticSafetyGate(critic.run, critic.response);
          if (criticSafetyGate) {
            return criticSafetyGate;
          }

          const criticResponseRef = latestProviderResponseArtifactRef(critic.run, "critic");
          const criticTriggerRef = latestCriticTriggerArtifact(critic.run)?.ref;
          const criticRevision = decideRevisionPacket("critic", critic.response);
          if (criticRevision.shouldRevise) {
            return writeAndDelegateRevision(critic.run, {
              decision: criticRevision,
              response: critic.response,
              evidenceRefs: [
                ...qaEvidenceRefs,
                ...[criticResponseRef, criticTriggerRef].filter((ref): ref is string => Boolean(ref))
              ],
              ...(criticResponseRef ? { sourceResponseRef: criticResponseRef } : {}),
              ...(criticTriggerRef ? { criticTriggerRef } : {})
            });
          }

          if (qaRevision.shouldRevise) {
            return writeAndDelegateRevision(critic.run, {
              decision: qaRevision,
              response: qaResult.response,
              evidenceRefs: [
                ...qaEvidenceRefs,
                ...[criticResponseRef, criticTriggerRef].filter((ref): ref is string => Boolean(ref))
              ],
              ...(qaResponseRef ? { sourceResponseRef: qaResponseRef } : {}),
              ...(criticTriggerRef ? { criticTriggerRef } : {})
            });
          }
        }

        return critic;
      }

      if (qaRevision.shouldRevise) {
        return writeAndDelegateRevision(qaCompleted, {
          decision: qaRevision,
          response: qaResult.response,
          evidenceRefs: qaEvidenceRefs,
          ...(qaResponseRef ? { sourceResponseRef: qaResponseRef } : {})
        });
      }

      return {
        run: qaCompleted,
        response: qaResult.response,
        advanced: true
      };
    }

    if (!verifierAssignment) {
      const approvalReason = "Verifier role is not assigned; user review is required before implementation can complete.";
      const gated = await updateRun(
        validationRun,
        {
          state: "awaiting_approval",
          approvalRequired: true,
          approvalReason
        },
        [createEvent("approval_required", approvalReason, {
          reason: "verifier_unassigned",
          reviewRoutingRef: routing.artifact.ref
        })],
        [approvalGateHandoff(validationRun, {
          reason: approvalReason,
          role: "verifier",
          gate: "verifier_unassigned",
          artifactRefs: [routing.artifact.ref]
        })]
      );

      return {
        run: gated,
        advanced: true,
        stopReason: approvalReason
      };
    }

    const revisionPacket = await latestRevisionPacketContext(validationRun);
    const result = await runAgent(validationRun, "verifier", {
      phase: "verify",
      changedPathCount: evidence.changedPaths.length,
      protectedChangeCount: evidence.protectedChanges.length,
      validationCommandCount: validation.executedCommands.length,
      validationFailureCount: validation.failedCommands.length,
      validationSummaryRef: validation.artifact.ref,
      reviewRoutingRef: routing.artifact.ref,
      ...(revisionPacket ? { latestRevisionPacket: revisionPacket } : {})
    });
    const stopped = await stopForProviderStatus(result.run, "verifier", result.response);

    if (stopped) {
      return {
        run: stopped.run,
        response: result.response,
        advanced: true,
        stopReason: stopped.stopReason
      };
    }

    const verdict = verdictFromResponse(result.response);
    const verifierResponseRef = latestProviderResponseArtifactRef(result.run, "verifier");

    if (verdict === "approve") {
      const stopReason = "Verifier approved runtime evidence.";
      const runWithFinalReport = await writeFinalReport(result.run, {
        role: "verifier",
        response: result.response,
        stopReason
      });
      const completed = await updateRun(
        runWithFinalReport,
        { state: "completed", stopReason },
        [createEvent("run_completed", stopReason)],
        [completionHandoff(runWithFinalReport, "verifier", stopReason)]
      );
      const progress = await writeProgressPacketArtifact(completed);

      return {
        run: progress.run,
        response: result.response,
        advanced: true
      };
    }

    const criticDecision = decideCriticTrigger({
      verifierResponse: result.response,
      validationFailureCount: validation.failedCommands.length,
      evidenceRefs: [
        validation.artifact.ref,
        ...[verifierResponseRef].filter((ref): ref is string => Boolean(ref))
      ]
    });
    const critic = await runCriticForTrigger(result.run, criticDecision);
    const verifierRevision = decideRevisionPacket("verifier", result.response);
    if (critic?.response) {
      const criticSafetyGate = await stopForCriticSafetyGate(critic.run, critic.response);
      if (criticSafetyGate) {
        return criticSafetyGate;
      }

      const criticResponseRef = latestProviderResponseArtifactRef(critic.run, "critic");
      const criticTriggerRef = latestCriticTriggerArtifact(critic.run)?.ref;
      const criticRevision = decideRevisionPacket("critic", critic.response);

      if (criticRevision.shouldRevise) {
        return writeAndDelegateRevision(critic.run, {
          decision: criticRevision,
          response: critic.response,
          evidenceRefs: [
            validation.artifact.ref,
            ...[verifierResponseRef, criticResponseRef, criticTriggerRef].filter((ref): ref is string => Boolean(ref))
          ],
          ...(criticResponseRef ? { sourceResponseRef: criticResponseRef } : {}),
          ...(criticTriggerRef ? { criticTriggerRef } : {})
        });
      }

      if (verifierRevision.shouldRevise) {
        return writeAndDelegateRevision(critic.run, {
          decision: verifierRevision,
          response: result.response,
          evidenceRefs: [
            validation.artifact.ref,
            ...[verifierResponseRef, criticResponseRef, criticTriggerRef].filter((ref): ref is string => Boolean(ref))
          ],
          ...(verifierResponseRef ? { sourceResponseRef: verifierResponseRef } : {}),
          ...(criticTriggerRef ? { criticTriggerRef } : {})
        });
      }
    }

    if (critic) {
      return critic;
    }

    if (verifierRevision.shouldRevise) {
      return writeAndDelegateRevision(result.run, {
        decision: verifierRevision,
        response: result.response,
        evidenceRefs: [
          validation.artifact.ref,
          ...[verifierResponseRef].filter((ref): ref is string => Boolean(ref))
        ],
        ...(verifierResponseRef ? { sourceResponseRef: verifierResponseRef } : {})
      });
    }

    const approvalReason = `Verifier returned ${verdict ?? "no verdict"}.`;
    const gated = await updateRun(
      result.run,
      {
        state: "awaiting_approval",
        approvalRequired: true,
        approvalReason
      },
      [createEvent("approval_required", approvalReason)],
      [approvalGateHandoff(result.run, {
        reason: approvalReason,
        role: "verifier",
        gate: "verifier_verdict"
      })]
    );

    return {
      run: gated,
      response: result.response,
      advanced: true,
      stopReason: approvalReason
    };
  }

  return {
    run,
    advanced: false,
    stopReason: `No transition is available from state ${run.state}.`
  };
};

export const advanceRun = async (input: AdvanceRunInput): Promise<AdvanceRunResult> => {
  const maxSteps = input.maxSteps ?? 10;
  let run = await loadRun(input.repoPath, input.runId);
  const providerResponses: AgentResponse[] = [];
  let advanced = false;
  let stopReason = "No transition was available.";

  for (let step = 0; step < maxSteps; step += 1) {
    const result = await advanceOneStep(run);
    run = result.run;

    if (result.response) {
      providerResponses.push(result.response);
    }

    if (!result.advanced) {
      stopReason = result.stopReason ?? stopReason;
      break;
    }

    advanced = true;
    stopReason = result.stopReason ?? `Advanced to ${run.state}.`;

    if (terminalStates.has(run.state) || run.approvalRequired) {
      break;
    }
  }

  return {
    run,
    advanced,
    stopReason,
    providerResponses
  };
};
