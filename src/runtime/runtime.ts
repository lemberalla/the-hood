import { loadConfig } from "./config.js";
import { InputError } from "./errors.js";
import { newId, nowIso } from "./ids.js";
import { assertRoleInvariants } from "./permissions.js";
import { getProjectPaths, resolveRepoPath } from "./paths.js";
import { saveRun, loadRun, listRuns as loadRuns } from "./store.js";
import type {
  ApprovalDecision,
  ApprovalEvent,
  RoleMap,
  RunEvent,
  RunMode,
  RunRecord,
  RunState,
  RuntimeRole
} from "./types.js";

export interface CreateRunInput {
  repoPath: string;
  goal: string;
  mode: RunMode;
  roleOverrides?: RoleMap;
  preferredRole?: RuntimeRole;
  constraints?: string[];
}

const createEvent = (type: string, message: string): RunEvent => ({
  id: newId("event"),
  createdAt: nowIso(),
  type,
  message
});

const createApprovalEvent = (decision: ApprovalDecision, reason: string): ApprovalEvent => ({
  id: newId("approval"),
  createdAt: nowIso(),
  decision,
  reason
});

const approvedStateForRun = (run: RunRecord): RunState => {
  if (run.state !== "awaiting_approval") {
    return run.state;
  }

  if (run.approvalReason?.includes("apply isolated patch")) {
    return "integrating";
  }

  if (run.approvalReason?.includes("protected test changes")) {
    return "verifying";
  }

  return run.mode === "implement" ? "delegating" : "planning";
};

const initialStateForMode = (mode: RunMode): { state: RunState; approvalRequired: boolean; reason?: string } => {
  if (mode === "implement") {
    return {
      state: "awaiting_approval",
      approvalRequired: true,
      reason: "Implementation mode requires approval before edit-capable worker execution."
    };
  }

  return {
    state: "created",
    approvalRequired: false
  };
};

export const createRun = async (input: CreateRunInput): Promise<RunRecord> => {
  const repoPath = resolveRepoPath(input.repoPath);
  const goal = input.goal.trim();

  if (!goal) {
    throw new InputError("Run goal cannot be empty.");
  }

  const config = await loadConfig(repoPath);
  const roleMapping = {
    ...config.roles,
    ...(input.roleOverrides ?? {})
  };
  assertRoleInvariants(roleMapping);

  const initial = initialStateForMode(input.mode);
  const createdAt = nowIso();
  const run: RunRecord = {
    runId: newId("run"),
    createdAt,
    updatedAt: createdAt,
    repoPath,
    userGoal: goal,
    mode: input.mode,
    state: initial.state,
    ...(input.preferredRole ? { preferredRole: input.preferredRole } : {}),
    roleMapping,
    constraints: input.constraints ?? [],
    maxIterations: config.defaults.maxIterations,
    approvalRequired: initial.approvalRequired,
    artifacts: [
      {
        kind: "metadata",
        ref: getProjectPaths(repoPath).configPath,
        summary: "Runtime configuration used to create this run."
      }
    ],
    approvalEvents: [],
    toolEvents: [],
    events: [
      createEvent("run_created", `Created ${input.mode} run.`),
      createEvent(
        "run_ready",
        "Run is ready for the next runtime transition."
      )
    ]
  };

  if (initial.reason) {
    run.approvalReason = initial.reason;
    run.events.push(createEvent("approval_required", initial.reason));
  }

  await saveRun(run);
  return run;
};

export const getRun = async (repoPath: string, runId: string): Promise<RunRecord> =>
  loadRun(repoPath, runId);

export const listRuns = async (repoPath: string): Promise<RunRecord[]> => loadRuns(repoPath);

export const recordApproval = async (
  repoPath: string,
  runId: string,
  decision: ApprovalDecision,
  reason: string
): Promise<RunRecord> => {
  const run = await loadRun(repoPath, runId);
  const approval = createApprovalEvent(decision, reason);
  const updatedAt = nowIso();
  const { approvalReason: _approvalReason, ...runWithoutApprovalReason } = run;

  const state: RunState =
    decision === "reject"
      ? "aborted"
      : decision === "revise"
        ? "awaiting_approval"
        : approvedStateForRun(run);

  const base: RunRecord = {
    ...(decision === "revise" ? run : runWithoutApprovalReason),
    updatedAt,
    state,
    approvalRequired: decision === "revise",
    approvalEvents: [...run.approvalEvents, approval],
    events: [
      ...run.events,
      createEvent("approval_recorded", `Recorded approval decision: ${decision}.`)
    ]
  };
  const updated: RunRecord =
    decision === "revise"
      ? {
          ...base,
          approvalReason: "Revision requested before continuing."
        }
      : base;

  await saveRun(updated);
  return updated;
};

export const abortRun = async (repoPath: string, runId: string, reason: string): Promise<RunRecord> => {
  const run = await loadRun(repoPath, runId);
  const updated: RunRecord = {
    ...run,
    updatedAt: nowIso(),
    state: "aborted",
    approvalRequired: false,
    stopReason: reason,
    events: [...run.events, createEvent("run_aborted", reason)]
  };

  await saveRun(updated);
  return updated;
};
