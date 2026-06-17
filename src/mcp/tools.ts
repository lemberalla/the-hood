import { abortRun, createRun, getRun, recordApproval } from "../runtime/runtime.js";
import { captureGitEvidence } from "../runtime/gitEvidence.js";
import { advanceRun } from "../runtime/loop.js";
import type { ApprovalDecision, JsonObject, JsonValue, RoleMap, RunRecord } from "../runtime/types.js";
import { parseRoleAssignment } from "../runtime/role-assignment.js";
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
  createPlanTool(),
  createOrchestrateTool(),
  createContinueTool(),
  createStatusTool(),
  createCaptureEvidenceTool(),
  createAbortTool()
];

export const findTool = (name: string): McpTool | undefined =>
  mcpTools.find((tool) => tool.definition.name === name);
