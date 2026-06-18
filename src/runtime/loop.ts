import fs from "node:fs/promises";
import { requiredAssignment, runAgent } from "./agentRunner.js";
import { autoApprovalReason, evaluateExternalTransferPolicy } from "./approvalPolicy.js";
import { writeRunArtifact } from "./artifacts.js";
import { runRuntimeCommand } from "./commandRunner.js";
import { loadConfig } from "./config.js";
import {
  transferManifestSummary,
  writeExternalTransferManifestArtifact
} from "./externalTransfer.js";
import { captureGitEvidence, parseGitStatusPaths } from "./gitEvidence.js";
import { newId, nowIso } from "./ids.js";
import { findProtectedPathMatches, type ProtectedPathMatch } from "./protectedPaths.js";
import { writeProgressPacketArtifact } from "./progressPacket.js";
import {
  analyzeRepoContextRequest,
  captureRepoContext,
  latestRepoContextArtifact,
  readLatestRepoContext
} from "./repoContext.js";
import { loadRun, saveRun } from "./store.js";
import { captureValidationEvidence } from "./validationCommands.js";
import type { AgentResponse } from "../providers/types.js";
import type {
  ApprovalEvent,
  JsonObject,
  JsonValue,
  RoleAssignment,
  RunArtifact,
  RunEvent,
  RunRecord,
  RunState,
  RuntimeRole,
  ToolEvent
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

const updateRun = async (
  run: RunRecord,
  updates: Partial<Pick<RunRecord, "state" | "approvalRequired" | "approvalReason" | "stopReason">>,
  events: RunEvent[]
): Promise<RunRecord> => {
  const { approvalReason: _approvalReason, stopReason: _stopReason, ...base } = run;
  const next: RunRecord = {
    ...base,
    ...updates,
    updatedAt: nowIso(),
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

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
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
    .filter((candidate) => candidate.type === "approval_required" && candidate.data?.reason === "isolated_patch_application")
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
        }))
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
      [createEvent("approval_required", approvalReason)]
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
      ]
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
    ]
  );

  return {
    run: verifying
  };
};

const stopForProviderInvocationApproval = async (
  run: RunRecord,
  role: RuntimeRole,
  assignment: RoleAssignment
): Promise<{ run: RunRecord; response: AgentResponse; stopReason: string } | undefined> => {
  if (
    !readOnlyProvidersRequiringInvocationApproval.has(assignment.provider) ||
    hasProviderResponded(run, role, assignment) ||
    hasProviderInvocationApproval(run, assignment)
  ) {
    return undefined;
  }

  const approvalReason = providerInvocationApprovalReason(role, assignment);
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
    ]
  );

  return {
    run: gated,
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
      [createEvent("approval_required", stopReason)]
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
  const repoContext = await readLatestRepoContext(run);
  const contextArtifact = latestRepoContextArtifact(run);

  return {
    phase: run.mode,
    ...(repoContext ? { repoContext: repoContext as unknown as JsonObject } : {}),
    ...(contextArtifact
      ? {
          repoContextArtifact: {
            kind: contextArtifact.kind,
            ref: contextArtifact.ref,
            summary: contextArtifact.summary
          }
        }
      : {})
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
    const existingContextArtifact = latestRepoContextArtifact(result.run);
    const decision = decisionFromResponse(result.response);

    if (existingContextArtifact) {
      const analysis = await analyzeRepoContextRequest(result.run, decision);

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
              existingContextArtifactRef: existingContextArtifact.ref
            })
          ]
        );

        return {
          run: gated,
          response: result.response,
          advanced: true,
          stopReason: approvalReason
        };
      }
    }

    const repoContext = await captureRepoContext(result.run, decision);

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
      [createEvent("approval_required", approvalReason)]
    );

    return {
      run: gated,
      response: result.response,
      advanced: true,
      stopReason: approvalReason
    };
  }

  const stopReason = `${role} run completed by provider response.`;
  const runWithFinalReport = await writeFinalReport(result.run, {
    role,
    response: result.response,
    stopReason
  });
  const completed = await updateRun(
    runWithFinalReport,
    { state: "completed", stopReason },
    [createEvent("run_completed", `${role} run completed.`)]
  );
  const progress = await writeProgressPacketArtifact(completed);

  return {
    run: progress.run,
    response: result.response,
    advanced: true
  };
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
      [createEvent("state_changed", `Run entered ${run.mode} execution with ${role}.`)]
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
      [createEvent("state_changed", "Run entered implementation.")]
    );

    return {
      run: next,
      response: result.response,
      advanced: true
    };
  }

  if (run.state === "implementing") {
    const result = await runAgent(run, "implementer", {
      phase: "implement"
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
        ]
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
      [createEvent("state_changed", "Run entered verification.")]
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
    const result = await runAgent(validation.run, "verifier", {
      phase: "verify",
      changedPathCount: evidence.changedPaths.length,
      protectedChangeCount: evidence.protectedChanges.length,
      validationCommandCount: validation.executedCommands.length,
      validationFailureCount: validation.failedCommands.length,
      validationSummaryRef: validation.artifact.ref
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
        [createEvent("run_completed", stopReason)]
      );
      const progress = await writeProgressPacketArtifact(completed);

      return {
        run: progress.run,
        response: result.response,
        advanced: true
      };
    }

    const approvalReason = `Verifier returned ${verdict ?? "no verdict"}.`;
    const gated = await updateRun(
      result.run,
      {
        state: "awaiting_approval",
        approvalRequired: true,
        approvalReason
      },
      [createEvent("approval_required", approvalReason)]
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
