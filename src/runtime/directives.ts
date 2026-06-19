import { loadConfig } from "./config.js";
import { defaultRolePermissions } from "./permissions.js";
import { formatRoleAssignment } from "./role-assignment.js";
import type { AgentDirective, AgentOutputContract } from "../providers/types.js";
import type { JsonObject, RoleAssignment, RunRecord, RuntimeRole } from "./types.js";

const outputContracts: Record<RuntimeRole, AgentOutputContract> = {
  orchestrator: {
    schemaVersion: 1,
    name: "orchestrator_decision",
    requiredDataKey: "decision"
  },
  planner: {
    schemaVersion: 1,
    name: "planner_decision",
    requiredDataKey: "decision"
  },
  researcher: {
    schemaVersion: 1,
    name: "research_result",
    requiredDataKey: "researchResult"
  },
  implementer: {
    schemaVersion: 1,
    name: "implementation_result",
    requiredDataKey: "implementationResult"
  },
  verifier: {
    schemaVersion: 1,
    name: "verification_result",
    requiredDataKey: "verificationResult"
  },
  critic: {
    schemaVersion: 1,
    name: "critique_result",
    requiredDataKey: "critiqueResult"
  },
  integrator: {
    schemaVersion: 1,
    name: "integration_result",
    requiredDataKey: "integrationResult"
  },
  citation: {
    schemaVersion: 1,
    name: "citation_result",
    requiredDataKey: "citationResult"
  }
};

const roleObjectives: Record<RuntimeRole, string> = {
  orchestrator: "Plan the next step, delegate narrowly, and decide whether more evidence or user approval is needed.",
  planner: "Create a repo-grounded plan with risks, acceptance criteria, and a small execution path.",
  researcher: "Gather relevant facts and source-grounded context without editing files.",
  implementer: "Make only the scoped changes required for the task and report unresolved risks honestly.",
  verifier: "Independently validate runtime evidence and recommend approve, revise, abort, or ask_user.",
  critic: "Challenge the plan or patch for missing cases, unsafe assumptions, and better alternatives.",
  integrator: "Apply only approved changes and preserve the target checkout state.",
  citation: "Verify evidence references and attribution without changing source files."
};

const roleInstructions: Record<RuntimeRole, string[]> = {
  orchestrator: [
    "Do not edit files directly.",
    "Delegate the smallest useful task to one role at a time.",
    "Ask for approval when policy, uncertainty, or protected paths require it.",
    "When approvalPolicy.mode is autopilot, do not ask the user to approve bounded gates the runtime can enforce.",
    "Return structured data matching the output contract."
  ],
  planner: [
    "Inspect provided context before proposing work.",
    "Separate facts from assumptions.",
    "Prefer minimal, reversible steps.",
    "When approvalPolicy.mode is autopilot, plan around runtime-enforced gates instead of asking for user approval.",
    "Return structured data matching the output contract."
  ],
  researcher: [
    "Do not edit files.",
    "Prefer primary sources and direct repository evidence.",
    "Record uncertainty explicitly.",
    "Return structured data matching the output contract."
  ],
  implementer: [
    "Change only files needed for the assigned task.",
    "Do not change tests, fixtures, snapshots, or evals unless explicitly approved.",
    "Do not claim final acceptance; verification is separate.",
    "Return structured data matching the output contract."
  ],
  verifier: [
    "Do not edit files.",
    "Treat runtime-captured commands, diffs, and logs as stronger evidence than model summaries.",
    "Fail closed when evidence is missing or protected files changed without approval.",
    "Return structured data matching the output contract."
  ],
  critic: [
    "Do not edit files.",
    "Focus on concrete risks, missing cases, and unsafe assumptions.",
    "Separate blocking concerns from non-blocking improvements.",
    "Return structured data matching the output contract."
  ],
  integrator: [
    "Apply only approved changes.",
    "Do not expand scope.",
    "Preserve unrelated user work.",
    "Return structured data matching the output contract."
  ],
  citation: [
    "Do not edit files.",
    "Verify that cited evidence supports the claim.",
    "Flag missing or weak attribution.",
    "Return structured data matching the output contract."
  ]
};

const enabledTools = (permissions: AgentDirective["toolPermissions"]): string[] =>
  Object.entries(permissions)
    .filter(([, enabled]) => enabled)
    .map(([tool]) => tool);

const disabledTools = (permissions: AgentDirective["toolPermissions"]): string[] =>
  Object.entries(permissions)
    .filter(([, enabled]) => !enabled)
    .map(([tool]) => tool);

export const buildAgentDirective = async (
  run: RunRecord,
  role: RuntimeRole,
  assignment: RoleAssignment,
  context: JsonObject
): Promise<AgentDirective> => {
  const config = await loadConfig(run.repoPath);
  const toolPermissions = defaultRolePermissions[role];
  const outputContract = outputContracts[role];
  const outputContractVariables: JsonObject = {
    schemaVersion: outputContract.schemaVersion,
    name: outputContract.name,
    requiredDataKey: outputContract.requiredDataKey
  };

  return {
    role,
    objective: roleObjectives[role],
    instructions: roleInstructions[role],
    toolPermissions,
    outputContract,
    variables: {
      run: {
        runId: run.runId,
        userGoal: run.userGoal,
        mode: run.mode,
        repoPath: run.repoPath,
        currentState: run.state,
        constraints: run.constraints,
        maxIterations: run.maxIterations,
        approvalPolicy: {
          mode: config.approvalPolicy.mode,
          editRequiresApproval: config.defaults.editRequiresApproval,
          dependencyInstallRequiresApproval: config.defaults.dependencyInstallRequiresApproval,
          networkRequiresApproval: config.defaults.networkRequiresApproval,
          protectedTestPaths: config.defaults.protectedTestPaths,
          externalTransfers: {
            mode: config.approvalPolicy.externalTransfers.mode,
            maxAutoApproveBytes: config.approvalPolicy.externalTransfers.maxAutoApproveBytes
          }
        },
        stopConditions: [
          "terminal_state",
          "approval_required",
          "provider_error",
          "schema_validation_failed",
          "max_iterations"
        ]
      },
      role: {
        name: role,
        assignment: formatRoleAssignment(assignment),
        provider: assignment.provider,
        model: assignment.model,
        allowedTools: enabledTools(toolPermissions),
        disallowedTools: disabledTools(toolPermissions),
        outputContract: outputContractVariables
      },
      context
    }
  };
};
