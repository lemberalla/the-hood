import { autopilotApprovalReason, autopilotPolicyReason, isAutopilotEnabled } from "./approvalPolicy.js";
import { loadConfig } from "./config.js";
import { InputError } from "./errors.js";
import { createRunHandoff } from "./handoffs.js";
import { newId, nowIso } from "./ids.js";
import { defaultRolePermissions } from "./permissions.js";
import { requiredAssignment, runAgent } from "./agentRunner.js";
import { latestRepoContextArtifact } from "./repoContext.js";
import {
  captureRemoteRepoContext,
  latestRemoteRepoContextArtifact,
  readLatestRemoteRepoContext,
  remoteRepoContextArtifacts
} from "./remoteRepoContext.js";
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

export interface SummonAgentInput {
  repoPath: string;
  runId: string;
  role: RuntimeRole;
  brief: string;
  summonKind?: string;
  persona?: string;
  agent?: RoleAssignment;
  constraints?: string[];
  evidenceRefs?: string[];
}

export interface SummonAgentResult {
  run: RunRecord;
  role: RuntimeRole;
  assignment: RoleAssignment;
  summonKind: string;
  advanced: boolean;
  stopReason: string;
  providerResponses: AgentResponse[];
  directiveArtifact?: RunArtifact;
  responseArtifact?: RunArtifact;
}

const summonableRoles: RuntimeRole[] = [
  "orchestrator",
  "planner",
  "researcher",
  "qa",
  "verifier",
  "critic"
];

const readOnlyProvidersRequiringInvocationApproval = new Set([
  "anthropic-api",
  "chatgpt-web",
  "claude-code",
  "codex-cli",
  "openai-api"
]);

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

const truncateText = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;

const isSummonableRole = (role: RuntimeRole): boolean =>
  summonableRoles.includes(role) && !defaultRolePermissions[role].edit;

const providerInvocationApprovalReason = (role: RuntimeRole, assignment: RoleAssignment): string =>
  `Invoking ${assignment.provider}:${assignment.model} for summoned ${role} requires explicit approval. ` +
  `Approval message must mention "invoke ${assignment.provider}".`;

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

const providerInvocationGateResponse = (role: RuntimeRole, summary: string): AgentResponse => {
  switch (role) {
    case "orchestrator":
    case "planner":
      return {
        status: "blocked",
        summary,
        data: {
          decision: {
            action: "request_approval",
            reason: summary
          }
        }
      };
    case "researcher":
      return {
        status: "blocked",
        summary,
        data: {
          researchResult: {
            status: "blocked",
            summary,
            findings: [],
            sources: []
          }
        }
      };
    case "qa":
      return {
        status: "blocked",
        summary,
        data: {
          qaResult: {
            verdict: "blocked",
            summary,
            suggestedCommands: [],
            risks: [summary]
          }
        }
      };
    case "verifier":
      return {
        status: "blocked",
        summary,
        data: {
          verificationResult: {
            verdict: "ask_user",
            summary,
            failedCriteria: ["provider_invocation"],
            risks: [summary],
            nextAction: "user"
          }
        }
      };
    case "critic":
      return {
        status: "blocked",
        summary,
        data: {
          critiqueResult: {
            verdict: "unclear",
            blockingConcerns: [summary],
            nonBlockingConcerns: []
          }
        }
      };
    default:
      return {
        status: "blocked",
        summary,
        data: {
          result: {
            status: "blocked",
            summary
          }
        }
      };
  }
};

const runWithSummonAssignment = (
  run: RunRecord,
  role: RuntimeRole,
  assignment: RoleAssignment
): RunRecord => ({
  ...run,
  roleMapping: {
    ...run.roleMapping,
    [role]: assignment
  }
});

const appendSummonRequested = async (
  run: RunRecord,
  input: Required<Pick<SummonAgentInput, "role" | "brief">> & {
    summonKind: string;
    persona?: string;
    constraints: string[];
    evidenceRefs: string[];
  },
  assignment: RoleAssignment
): Promise<RunRecord> => {
  const latest = await loadRun(run.repoPath, run.runId);
  const runForHandoff = runWithSummonAssignment(latest, input.role, assignment);
  const data: JsonObject = {
    role: input.role,
    summonKind: input.summonKind,
    provider: assignment.provider,
    model: assignment.model,
    brief: truncateText(input.brief, 500),
    constraints: input.constraints,
    evidenceRefs: input.evidenceRefs
  };

  if (input.persona) {
    data.persona = truncateText(input.persona, 500);
  }

  const updated: RunRecord = {
    ...latest,
    updatedAt: nowIso(),
    events: [
      ...latest.events,
      createEvent("agent_summoned", `Summoned ${input.role} for ${input.summonKind}.`, data)
    ],
    handoffs: [
      ...(latest.handoffs ?? []),
      createRunHandoff(runForHandoff, {
        kind: "agent_handoff",
        reason: `Summon ${input.role} for ${input.summonKind}.`,
        stateAfter: latest.state,
        toRole: input.role,
        ...(input.evidenceRefs.length > 0 ? { artifactRefs: input.evidenceRefs } : {})
      })
    ]
  };

  await saveRun(updated);
  return updated;
};

const autoApproveProviderInvocation = async (
  run: RunRecord,
  role: RuntimeRole,
  assignment: RoleAssignment,
  reason: string
): Promise<RunRecord> => {
  const approvalReason = autopilotApprovalReason(reason);
  const approval = createApprovalEvent(approvalReason);
  const runForHandoff = runWithSummonAssignment(run, role, assignment);
  const updated: RunRecord = {
    ...run,
    updatedAt: nowIso(),
    approvalEvents: [...run.approvalEvents, approval],
    events: [
      ...run.events,
      createEvent("approval_auto_approved", approvalReason, {
        gate: "summon_provider_invocation",
        gateReason: reason,
        policyDecision: "auto_approve",
        policyReason: autopilotPolicyReason("summon_provider_invocation"),
        role,
        provider: assignment.provider,
        model: assignment.model
      })
    ],
    handoffs: [
      ...(run.handoffs ?? []),
      createRunHandoff(runForHandoff, {
        kind: "approval_auto_approved",
        reason: approvalReason,
        stateAfter: run.state,
        toRole: role,
        gate: "summon_provider_invocation",
        approvalEventId: approval.id
      })
    ]
  };

  await saveRun(updated);
  return updated;
};

const stopForProviderInvocationApproval = async (
  run: RunRecord,
  role: RuntimeRole,
  assignment: RoleAssignment
): Promise<{ run: RunRecord; gated: boolean; response?: AgentResponse; stopReason?: string }> => {
  if (
    !readOnlyProvidersRequiringInvocationApproval.has(assignment.provider) ||
    hasProviderInvocationApproval(run, assignment)
  ) {
    return {
      run,
      gated: false
    };
  }

  const approvalReason = providerInvocationApprovalReason(role, assignment);
  const config = await loadConfig(run.repoPath);

  if (isAutopilotEnabled(config)) {
    return {
      run: await autoApproveProviderInvocation(run, role, assignment, approvalReason),
      gated: false
    };
  }

  if (run.approvalRequired && run.approvalReason && run.approvalReason !== approvalReason) {
    throw new InputError(`Run ${run.runId} is already waiting for approval: ${run.approvalReason}`);
  }

  const runForHandoff = runWithSummonAssignment(run, role, assignment);
  const gated: RunRecord = {
    ...run,
    updatedAt: nowIso(),
    approvalRequired: true,
    approvalReason,
    events: [
      ...run.events,
      createEvent("approval_required", approvalReason, {
        role,
        provider: assignment.provider,
        model: assignment.model,
        reason: "summon_provider_invocation"
      })
    ],
    handoffs: [
      ...(run.handoffs ?? []),
      createRunHandoff(runForHandoff, {
        kind: "approval_gate",
        reason: approvalReason,
        stateAfter: run.state,
        toRole: role,
        gate: "summon_provider_invocation"
      })
    ]
  };

  await saveRun(gated);
  return {
    run: gated,
    gated: true,
    response: providerInvocationGateResponse(role, approvalReason),
    stopReason: approvalReason
  };
};

const summonContext = async (
  run: RunRecord,
  input: Required<Pick<SummonAgentInput, "role" | "brief">> & {
    summonKind: string;
    persona?: string;
    constraints: string[];
    evidenceRefs: string[];
  }
): Promise<JsonObject> => {
  const remoteRepoContext = await readLatestRemoteRepoContext(run);
  const remoteContextArtifact = latestRemoteRepoContextArtifact(run);
  const remoteContextArtifacts = remoteRepoContextArtifacts(run);
  const summon: JsonObject = {
    schemaVersion: 1,
    kind: input.summonKind,
    role: input.role,
    brief: input.brief,
    constraints: input.constraints,
    evidenceRefs: input.evidenceRefs,
    safety: "This is a read-only same-run summon. Do not edit files or take runtime actions directly.",
    memoryInstruction: "Treat runtime artifacts and run state as canonical. Ignore stale provider session context."
  };

  if (input.persona) {
    summon.persona = input.persona;
  }

  return {
    phase: "summon",
    summon,
    ...(remoteRepoContext ? { remoteRepoContext: remoteRepoContext as unknown as JsonObject } : {}),
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
      : {}),
    runState: {
      runId: run.runId,
      state: run.state,
      mode: run.mode,
      approvalRequired: run.approvalRequired,
      approvalReason: run.approvalReason ?? null,
      stopReason: run.stopReason ?? null
    },
    recentArtifacts: run.artifacts.slice(-12).map((artifact) => ({
      kind: artifact.kind,
      ref: artifact.ref,
      summary: artifact.summary
    }))
  };
};

const appendSummonCompleted = async (
  run: RunRecord,
  role: RuntimeRole,
  assignment: RoleAssignment,
  response: AgentResponse,
  directiveArtifact: RunArtifact,
  responseArtifact: RunArtifact
): Promise<RunRecord> => {
  const latest = await loadRun(run.repoPath, run.runId);
  const updated: RunRecord = {
    ...latest,
    updatedAt: nowIso(),
    events: [
      ...latest.events,
      createEvent("summon_completed", `Summoned ${role} responded: ${response.summary}`, {
        role,
        provider: assignment.provider,
        model: assignment.model,
        status: response.status,
        directiveArtifactRef: directiveArtifact.ref,
        artifactRef: responseArtifact.ref
      })
    ]
  };

  await saveRun(updated);
  return updated;
};

export const summonAgent = async (input: SummonAgentInput): Promise<SummonAgentResult> => {
  if (!isSummonableRole(input.role)) {
    throw new InputError("Summon role must be orchestrator, planner, researcher, qa, verifier, or critic.");
  }

  const brief = input.brief.trim();
  if (!brief) {
    throw new InputError("Summon brief cannot be empty.");
  }

  const initialRun = await loadRun(input.repoPath, input.runId);
  const assignment = input.agent ?? requiredAssignment(initialRun, input.role);
  const summonKind = input.summonKind?.trim() || (input.role === "qa" ? "qa" : "review");
  const normalizedInput = {
    role: input.role,
    brief,
    summonKind,
    ...(input.persona ? { persona: input.persona } : {}),
    constraints: input.constraints ?? [],
    evidenceRefs: input.evidenceRefs ?? []
  };
  const requestedRun = await appendSummonRequested(initialRun, normalizedInput, assignment);
  const providerGate = await stopForProviderInvocationApproval(requestedRun, input.role, assignment);

  if (providerGate.gated) {
    return {
      run: providerGate.run,
      role: input.role,
      assignment,
      summonKind,
      advanced: true,
      stopReason: providerGate.stopReason ?? "Provider invocation approval is required.",
      providerResponses: providerGate.response ? [providerGate.response] : []
    };
  }

  let runForProvider = providerGate.run;
  if (!latestRepoContextArtifact(runForProvider) && !latestRemoteRepoContextArtifact(runForProvider)) {
    const remoteContext = await captureRemoteRepoContext(runForProvider, assignment, {
      action: "inspect_repo",
      reason: "same_run_summon",
      role: input.role,
      summonKind
    });

    if (remoteContext.selected) {
      runForProvider = remoteContext.run;
    }
  }

  const result = await runAgent(
    runForProvider,
    input.role,
    await summonContext(runForProvider, normalizedInput),
    {
      assignment,
      responseArtifactKind: "agent",
      responseArtifactNamePrefix: `summon-${input.role}`,
      responseArtifactSummary: (response) => `Summon ${input.role} response: ${response.summary}`,
      responseEventType: "summon_response"
    }
  );
  const completedRun = await appendSummonCompleted(
    result.run,
    input.role,
    assignment,
    result.response,
    result.directiveArtifact,
    result.responseArtifact
  );

  return {
    run: completedRun,
    role: input.role,
    assignment,
    summonKind,
    advanced: true,
    stopReason: result.response.summary,
    providerResponses: [result.response],
    directiveArtifact: result.directiveArtifact,
    responseArtifact: result.responseArtifact
  };
};
