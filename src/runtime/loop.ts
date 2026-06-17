import { writeRunArtifact } from "./artifacts.js";
import { captureGitEvidence } from "./gitEvidence.js";
import { newId, nowIso } from "./ids.js";
import { getProviderAdapter } from "../providers/router.js";
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
  const response = await adapter.runAgent({
    run,
    role,
    assignment,
    context
  });
  const artifact = await writeRunArtifact({
    repoPath: run.repoPath,
    runId: run.runId,
    kind: role === "orchestrator" || role === "planner" ? "plan" : "agent",
    name: `${role}-${newId("response")}.json`,
    content: `${JSON.stringify(response, null, 2)}\n`,
    summary: `${role} response: ${response.summary}`
  });
  const updated: RunRecord = {
    ...run,
    updatedAt: nowIso(),
    artifacts: [...run.artifacts, artifact],
    events: [
      ...run.events,
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
    const planned = await updateRun(
      run,
      { state: "planning" },
      [createEvent("state_changed", "Run entered planning.")]
    );
    const result = await runAgent(planned, "orchestrator", {
      phase: "plan"
    });
    const completed = await updateRun(
      result.run,
      { state: "completed", stopReason: "Plan run completed by provider response." },
      [createEvent("run_completed", "Plan run completed.")]
    );

    return {
      run: completed,
      response: result.response,
      advanced: true
    };
  }

  if (run.state === "delegating") {
    const result = await runAgent(run, "orchestrator", {
      phase: "delegate"
    });
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
