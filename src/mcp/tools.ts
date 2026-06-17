import { loadConfig, writeConfig } from "../runtime/config.js";
import { inspectRuntimeHealth } from "../runtime/doctor.js";
import { abortRun, createRun, getRun, recordApproval } from "../runtime/runtime.js";
import { captureGitEvidence } from "../runtime/gitEvidence.js";
import { advanceRun } from "../runtime/loop.js";
import { assertRoleInvariants } from "../runtime/permissions.js";
import type { ApprovalDecision, JsonObject, JsonValue, RoleMap, RunMode, RunRecord, RuntimeRole } from "../runtime/types.js";
import { formatRoleAssignment, parseRole, parseRoleAssignment } from "../runtime/role-assignment.js";
import { errorToolResult, toolResult, type ToolDefinition, type ToolResult } from "./protocol.js";
import {
  asObject,
  optionalRoleMapping,
  optionalRunMode,
  optionalString,
  optionalStringList,
  requiredString
} from "./validation.js";

type ToolHandler = (argumentsValue: JsonValue | undefined) => Promise<ToolResult>;

export interface McpTool {
  definition: ToolDefinition;
  handle: ToolHandler;
}

const runSummary = (run: RunRecord): JsonObject => ({
  run_id: run.runId,
  status: run.state,
  mode: run.mode,
  repo_path: run.repoPath,
  goal: run.userGoal,
  approval_required: run.approvalRequired,
  approval_reason: run.approvalReason ?? null,
  stop_reason: run.stopReason ?? null,
  artifacts: run.artifacts.map((artifact) => ({
    kind: artifact.kind,
    ref: artifact.ref,
    summary: artifact.summary
  }))
});

const toJsonObject = (value: unknown): JsonObject =>
  JSON.parse(JSON.stringify(value)) as JsonObject;

const roleSummary = (roles: RoleMap): JsonObject =>
  Object.fromEntries(
    Object.entries(roles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([role, assignment]) => [role, formatRoleAssignment(assignment)])
  );

const consultRoles = new Set(["orchestrator", "planner", "researcher", "critic"]);

const parseConsultRole = (value: string): RuntimeRole => {
  const role = parseRole(value);

  if (!consultRoles.has(role)) {
    throw new Error("role must be orchestrator, planner, researcher, or critic.");
  }

  return role;
};

const modeForConsultRole = (role: RuntimeRole): RunMode => {
  if (role === "critic") {
    return "review";
  }

  if (role === "researcher") {
    return "research";
  }

  return "plan";
};

const roleOverrideFromOrchestrator = (orchestrator: string | undefined): RoleMap => {
  if (!orchestrator) {
    return {};
  }

  return {
    orchestrator: parseRoleAssignment(orchestrator)
  };
};

const executeTool = async (
  argumentsValue: JsonValue | undefined,
  handler: (args: JsonObject) => Promise<JsonObject>
): Promise<ToolResult> => {
  try {
    return toolResult(await handler(asObject(argumentsValue, "arguments")));
  } catch (error) {
    return errorToolResult(error);
  }
};

const createPlanTool = (): McpTool => ({
  definition: {
    name: "thehood_plan",
    title: "Create TheHood Plan Run",
    description: "Create a read-only TheHood plan run using the configured orchestrator role.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal: {
          type: "string",
          description: "The user goal to plan."
        },
        repo_path: {
          type: "string",
          description: "Repository path for the run."
        },
        orchestrator: {
          type: "string",
          description: "Optional provider:model override for the orchestrator role."
        },
        constraints: {
          type: "array",
          items: {
            type: "string"
          }
        }
      },
      required: ["goal", "repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const run = await createRun({
        repoPath: requiredString(args, "repo_path"),
        goal: requiredString(args, "goal"),
        mode: "plan",
        roleOverrides: roleOverrideFromOrchestrator(optionalString(args, "orchestrator")),
        constraints: optionalStringList(args, "constraints")
      });

      return {
        ...runSummary(run),
        next_actions: ["Inspect the run with thehood_status.", "Continue provider wiring before model execution."]
      };
    })
});

const createOrchestrateTool = (): McpTool => ({
  definition: {
    name: "thehood_orchestrate",
    title: "Start TheHood Orchestration Run",
    description: "Create a TheHood run with optional role mapping overrides.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal: {
          type: "string"
        },
        repo_path: {
          type: "string"
        },
        mode: {
          type: "string",
          enum: ["plan", "research", "implement", "review"]
        },
        role_mapping: {
          type: "object",
          additionalProperties: {
            type: "string"
          }
        },
        constraints: {
          type: "array",
          items: {
            type: "string"
          }
        }
      },
      required: ["goal", "repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const run = await createRun({
        repoPath: requiredString(args, "repo_path"),
        goal: requiredString(args, "goal"),
        mode: optionalRunMode(args, "mode", "implement"),
        roleOverrides: optionalRoleMapping(args),
        constraints: optionalStringList(args, "constraints")
      });

      return {
        ...runSummary(run),
        summary: "TheHood created the run and stopped at the current runtime boundary."
      };
    })
});

const createDoctorTool = (): McpTool => ({
  definition: {
    name: "thehood_doctor",
    title: "Inspect TheHood Provider Health",
    description: "Report provider and role readiness without invoking model calls.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo_path: {
          type: "string"
        }
      },
      required: ["repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const config = await loadConfig(requiredString(args, "repo_path"));
      const health = await inspectRuntimeHealth(config);

      return health as unknown as JsonObject;
    })
});

const createRolesTool = (): McpTool => ({
  definition: {
    name: "thehood_roles",
    title: "Inspect TheHood Roles",
    description: "Inspect configured provider:model assignments for TheHood roles.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo_path: {
          type: "string"
        }
      },
      required: ["repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const repoPath = requiredString(args, "repo_path");
      const config = await loadConfig(repoPath);
      const health = await inspectRuntimeHealth(config);

      return {
        roles: roleSummary(config.roles),
        health: toJsonObject(health)
      };
    })
});

const createAssignRolesTool = (): McpTool => ({
  definition: {
    name: "thehood_assign_roles",
    title: "Assign TheHood Roles",
    description: "Persist provider:model assignments for one or more TheHood roles in the repo config.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo_path: {
          type: "string"
        },
        role_mapping: {
          type: "object",
          additionalProperties: {
            type: "string"
          }
        }
      },
      required: ["repo_path", "role_mapping"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const repoPath = requiredString(args, "repo_path");
      const config = await loadConfig(repoPath);
      const roleMapping = optionalRoleMapping(args);
      const updated = {
        ...config,
        roles: {
          ...config.roles,
          ...roleMapping
        }
      };

      assertRoleInvariants(updated.roles);
      await writeConfig(repoPath, updated);

      return {
        roles: roleSummary(updated.roles),
        health: toJsonObject(await inspectRuntimeHealth(updated))
      };
    })
});

const createConsultTool = (): McpTool => ({
  definition: {
    name: "thehood_consult",
    title: "Consult TheHood Guest Agent",
    description: "Run a single read-only role immediately, useful for asking Claude or another agent to plan, research, or critique from Codex chat.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal: {
          type: "string"
        },
        repo_path: {
          type: "string"
        },
        role: {
          type: "string",
          enum: ["orchestrator", "planner", "researcher", "critic"]
        },
        agent: {
          type: "string",
          description: "provider:model assignment, for example claude-code:opus or stub:critic."
        },
        constraints: {
          type: "array",
          items: {
            type: "string"
          }
        }
      },
      required: ["goal", "repo_path", "role", "agent"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const role = parseConsultRole(requiredString(args, "role"));
      const assignment = parseRoleAssignment(requiredString(args, "agent"));
      const run = await createRun({
        repoPath: requiredString(args, "repo_path"),
        goal: requiredString(args, "goal"),
        mode: modeForConsultRole(role),
        roleOverrides: {
          [role]: assignment
        },
        constraints: optionalStringList(args, "constraints")
      });
      const advanced = await advanceRun({
        repoPath: run.repoPath,
        runId: run.runId
      });

      return {
        ...runSummary(advanced.run),
        consulted_role: role,
        consulted_agent: formatRoleAssignment(assignment),
        advanced: advanced.advanced,
        stop_reason: advanced.stopReason,
        provider_response_count: advanced.providerResponses.length
      };
    })
});

const createContinueTool = (): McpTool => ({
  definition: {
    name: "thehood_continue",
    title: "Continue TheHood Run",
    description: "Record an optional approval decision and inspect the next runtime state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        run_id: {
          type: "string"
        },
        repo_path: {
          type: "string"
        },
        approval: {
          type: "string",
          enum: ["approve", "reject", "revise", "none"]
        },
        message: {
          type: "string"
        }
      },
      required: ["run_id", "repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const approval = optionalString(args, "approval") ?? "none";
      const repoPath = requiredString(args, "repo_path");
      const runId = requiredString(args, "run_id");
      const message = optionalString(args, "message") ?? "Continued through MCP.";

      if (!["approve", "reject", "revise", "none"].includes(approval)) {
        throw new Error("approval must be approve, reject, revise, or none.");
      }

      const run =
        approval === "none"
          ? await getRun(repoPath, runId)
          : await recordApproval(repoPath, runId, approval as ApprovalDecision, message);
      const advanced = await advanceRun({
        repoPath,
        runId: run.runId
      });

      return {
        ...runSummary(advanced.run),
        advanced: advanced.advanced,
        stop_reason: advanced.stopReason,
        provider_response_count: advanced.providerResponses.length
      };
    })
});

const createStatusTool = (): McpTool => ({
  definition: {
    name: "thehood_status",
    title: "Inspect TheHood Run",
    description: "Inspect a TheHood run by run id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        run_id: {
          type: "string"
        },
        repo_path: {
          type: "string"
        }
      },
      required: ["run_id", "repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const run = await getRun(requiredString(args, "repo_path"), requiredString(args, "run_id"));

      return {
        ...runSummary(run),
        events: run.events.map((event) => ({
          created_at: event.createdAt,
          type: event.type,
          message: event.message
        }))
      };
    })
});

const createCaptureEvidenceTool = (): McpTool => ({
  definition: {
    name: "thehood_capture_evidence",
    title: "Capture TheHood Git Evidence",
    description: "Capture git status, git diff, and protected path classifications for a run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        run_id: {
          type: "string"
        },
        repo_path: {
          type: "string"
        }
      },
      required: ["run_id", "repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const result = await captureGitEvidence(
        requiredString(args, "repo_path"),
        requiredString(args, "run_id")
      );

      return {
        ...runSummary(result.run),
        changed_paths: result.changedPaths,
        protected_changes: result.protectedChanges.map((match) => ({
          path: match.path,
          pattern: match.pattern
        })),
        artifacts: result.run.artifacts.map((artifact) => ({
          kind: artifact.kind,
          ref: artifact.ref,
          summary: artifact.summary
        }))
      };
    })
});

const createAbortTool = (): McpTool => ({
  definition: {
    name: "thehood_abort",
    title: "Abort TheHood Run",
    description: "Abort a TheHood run and record the reason.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        run_id: {
          type: "string"
        },
        repo_path: {
          type: "string"
        },
        reason: {
          type: "string"
        }
      },
      required: ["run_id", "repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const run = await abortRun(
        requiredString(args, "repo_path"),
        requiredString(args, "run_id"),
        optionalString(args, "reason") ?? "Aborted through MCP."
      );

      return runSummary(run);
    })
});

export const mcpTools: McpTool[] = [
  createDoctorTool(),
  createRolesTool(),
  createAssignRolesTool(),
  createPlanTool(),
  createOrchestrateTool(),
  createConsultTool(),
  createContinueTool(),
  createStatusTool(),
  createCaptureEvidenceTool(),
  createAbortTool()
];

export const findTool = (name: string): McpTool | undefined =>
  mcpTools.find((tool) => tool.definition.name === name);
