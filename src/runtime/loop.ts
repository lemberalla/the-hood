import { writeRunArtifact } from "./artifacts.js";
import { buildAgentDirective } from "./directives.js";
import { captureGitEvidence } from "./gitEvidence.js";
import { newId, nowIso } from "./ids.js";
import { getProviderAdapter } from "../providers/router.js";
import { validateAgentResponse } from "./responseContracts.js";
import { loadRun, saveRun } from "./store.js";
import type { AgentResponse } from "../providers/types.js";
import type { JsonObject, RoleAssignment, RunEvent, RunRecord, RunState, RuntimeRole } from "./types.js";

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

const requiredAssignment = (run: RunRecord, role: RuntimeRole): RoleAssignment => {
  const assignment = run.roleMapping[role];

  if (!assignment) {
    throw new Error(`Run ${run.runId} does not have a ${role} role assignment.`);
  }

  return assignment;
};

const runAgent = async (
  run: RunRecord,
  role: RuntimeRole,
  context: JsonObject
): Promise<{ run: RunRecord; response: AgentResponse }> => {
  const assignment = requiredAssignment(run, role);
  const adapter = getProviderAdapter(assignment);
  const callId = newId("response");
  const directive = await buildAgentDirective(run, role, assignment, context);
  const directiveArtifact = await writeRunArtifact({
    repoPath: run.repoPath,
    runId: run.runId,
    kind: "directive",
    name: `${role}-${callId}-directive.json`,
    content: `${JSON.stringify(directive, null, 2)}\n`,
    summary: `${role} directive for ${assignment.provider}:${assignment.model}`
  });
  const runWithDirective: RunRecord = {
    ...run,
    updatedAt: nowIso(),
    artifacts: [...run.artifacts, directiveArtifact],
    events: [
      ...run.events,
      createEvent("agent_directive_created", `${role} directive created.`, {
        role,
        provider: assignment.provider,
        model: assignment.model,
        outputContract: directive.outputContract.name
      })
    ]
  };

  await saveRun(runWithDirective);

  const response = await adapter.runAgent({
    run: runWithDirective,
    role,
    assignment,
    context,
    directive
  });
  validateAgentResponse(role, directive, response);

  const artifact = await writeRunArtifact({
    repoPath: runWithDirective.repoPath,
    runId: runWithDirective.runId,
    kind: role === "orchestrator" || role === "planner" ? "plan" : "agent",
    name: `${role}-${callId}-response.json`,
    content: `${JSON.stringify(response, null, 2)}\n`,
    summary: `${role} response: ${response.summary}`
  });
  const updated: RunRecord = {
    ...runWithDirective,
    updatedAt: nowIso(),
    artifacts: [...runWithDirective.artifacts, artifact],
    events: [
      ...runWithDirective.events,
      createEvent("agent_response", `${role} responded: ${response.summary}`, {
        role,
        provider: assignment.provider,
        model: assignment.model,
        status: response.status
      })
    ]
  };

  await saveRun(updated);

  return {
    run: updated,
    response
  };
};

const terminalStates = new Set<RunState>(["completed", "failed", "aborted"]);

const verdictFromResponse = (response: AgentResponse): string | undefined => {
  const value = response.data.verificationResult;

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const verdict = value.verdict;
    return typeof verdict === "string" ? verdict : undefined;
  }

  return undefined;
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

const executeReadOnlyRun = async (
  run: RunRecord,
  role: RuntimeRole
): Promise<{ run: RunRecord; response: AgentResponse; advanced: boolean; stopReason?: string }> => {
  const result = await runAgent(run, role, {
    phase: run.mode
  });
  const stopped = await stopForProviderStatus(result.run, role, result.response);

  if (stopped) {
    return {
      run: stopped.run,
      response: result.response,
      advanced: true,
      stopReason: stopped.stopReason
    };
  }

  const completed = await updateRun(
    result.run,
    { state: "completed", stopReason: `${role} run completed by provider response.` },
    [createEvent("run_completed", `${role} run completed.`)]
  );

  return {
    run: completed,
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

  if (run.state === "verifying") {
    const evidence = await captureGitEvidence(run.repoPath, run.runId);
    const result = await runAgent(evidence.run, "verifier", {
      phase: "verify",
      changedPathCount: evidence.changedPaths.length,
      protectedChangeCount: evidence.protectedChanges.length
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
      const completed = await updateRun(
        result.run,
        { state: "completed", stopReason: "Verifier approved runtime evidence." },
        [createEvent("run_completed", "Verifier approved runtime evidence.")]
      );

      return {
        run: completed,
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
