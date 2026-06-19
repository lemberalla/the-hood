import { loadConfig, writeConfig } from "../runtime/config.js";
import { inspectRuntimeHealth } from "../runtime/doctor.js";
import { abortRun, createRun, getRun, listRuns, recordApproval } from "../runtime/runtime.js";
import { captureGitEvidence } from "../runtime/gitEvidence.js";
import { fanoutAgents, type FanoutItemInput } from "../runtime/fanout.js";
import { advanceRun } from "../runtime/loop.js";
import { assertRoleInvariants } from "../runtime/permissions.js";
import { readRunArtifact } from "../runtime/artifacts.js";
import { readLatestExternalTransferManifest } from "../runtime/externalTransfer.js";
import { boundAgentMarkdownPayloads } from "../providers/markdownPayload.js";
import {
  getRepoGitDiff,
  getRepoGitStatus,
  listRepoTree,
  readRepoFile,
  searchRepo
} from "../runtime/repoGateway.js";
import { approvalMessageHint } from "../runtime/approvalInbox.js";
import { deriveOperatorNextActions } from "../runtime/operatorNextActions.js";
import { reconcileRun } from "../runtime/reconciliation.js";
import { getRunInsights } from "../runtime/runInsights.js";
import { summonAgent } from "../runtime/summons.js";
import type { AgentResponse } from "../providers/types.js";
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

const roleSummary = (roles: RoleMap): JsonObject =>
  Object.fromEntries(
    Object.entries(roles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([role, assignment]) => [role, formatRoleAssignment(assignment)])
  );

const artifactSummary = (artifact: RunRecord["artifacts"][number]): JsonObject => ({
  kind: artifact.kind,
  ref: artifact.ref,
  summary: artifact.summary
});

const runSummary = (run: RunRecord, insights?: JsonObject): JsonObject => ({
  run_id: run.runId,
  status: run.state,
  mode: run.mode,
  preferred_role: run.preferredRole ?? null,
  repo_path: run.repoPath,
  goal: run.userGoal,
  roles: roleSummary(run.roleMapping),
  approval_required: run.approvalRequired,
  approval_reason: run.approvalReason ?? null,
  stop_reason: run.stopReason ?? null,
  artifacts: run.artifacts.map((artifact) => ({
    kind: artifact.kind,
    ref: artifact.ref,
    summary: artifact.summary
  })),
  ...(insights ? { insights } : {}),
  next_actions: deriveOperatorNextActions(run) as unknown as JsonObject[]
});

const agentResponsesSummary = (responses: AgentResponse[]): JsonObject[] =>
  responses.map((response) => ({
    status: response.status,
    summary: response.summary,
    data: boundAgentMarkdownPayloads(response.data, 2_000)
  }));

const toJsonObject = (value: unknown): JsonObject =>
  JSON.parse(JSON.stringify(value)) as JsonObject;

const consultRoles = new Set(["orchestrator", "planner", "researcher", "qa", "critic"]);

const parseConsultRole = (value: string): RuntimeRole => {
  const role = parseRole(value);

  if (!consultRoles.has(role)) {
    throw new Error("role must be orchestrator, planner, researcher, qa, or critic.");
  }

  return role;
};

const modeForConsultRole = (role: RuntimeRole): RunMode => {
  if (role === "critic" || role === "qa") {
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

const optionalNumber = (source: JsonObject, key: string): number | undefined => {
  const value = source[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw new Error(`${key} must be a finite number when provided.`);
};

const optionalBoolean = (source: JsonObject, key: string): boolean | undefined => {
  const value = source[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`${key} must be a boolean when provided.`);
};

const requiredObjectArray = (source: JsonObject, key: string): JsonObject[] => {
  const value = source[key];

  if (!Array.isArray(value) || value.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
    throw new Error(`${key} must be an array of objects.`);
  }

  return value as JsonObject[];
};

const parseFanoutItem = (item: JsonObject): FanoutItemInput => {
  const agent = optionalString(item, "agent");
  const kind = optionalString(item, "kind");
  const summonKind = optionalString(item, "summon_kind");
  const persona = optionalString(item, "persona");
  const evidenceRefs = [
    ...optionalStringList(item, "evidence_refs"),
    ...optionalStringList(item, "evidenceRefs")
  ];

  return {
    role: parseRole(requiredString(item, "role")),
    brief: requiredString(item, "brief"),
    ...(kind ? { summonKind: kind } : {}),
    ...(summonKind ? { summonKind } : {}),
    ...(persona ? { persona } : {}),
    ...(agent ? { agent: parseRoleAssignment(agent) } : {}),
    constraints: optionalStringList(item, "constraints"),
    evidenceRefs
  };
};

const readOnlyAnnotations = (): JsonObject => ({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

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
        ...runSummary(run)
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
    description: "Create or advance a single read-only guest role, useful for asking Codex Spark, Pro, Claude, or another agent to plan, research, QA, or critique from Codex chat. Model-backed providers may stop for invocation approval before the provider is called.",
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
          enum: ["orchestrator", "planner", "researcher", "qa", "critic"]
        },
        agent: {
          type: "string",
          description: "provider:model assignment, for example codex-cli:spark, chatgpt-web:chatgpt-pro, claude-code:sonnet, or stub:critic."
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
        preferredRole: role,
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
        provider_response_count: advanced.providerResponses.length,
        provider_responses: agentResponsesSummary(advanced.providerResponses)
      };
    })
});

const createSummonTool = (): McpTool => ({
  definition: {
    name: "thehood_summon",
    title: "Summon Same-Run TheHood Agent",
    description: "Summon a read-only role onto an existing run for planning, review, QA, research, or critique. The runtime records the handoff and enforces provider invocation approval before model-backed calls.",
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
        role: {
          type: "string",
          enum: ["orchestrator", "planner", "researcher", "qa", "verifier", "critic"]
        },
        brief: {
          type: "string"
        },
        agent: {
          type: "string",
          description: "Optional one-call provider:model assignment, for example claude-code:default or stub:critic."
        },
        kind: {
          type: "string",
          description: "Optional summon kind such as review, qa, critique, research, or plan."
        },
        persona: {
          type: "string"
        },
        constraints: {
          type: "array",
          items: {
            type: "string"
          }
        },
        evidence_refs: {
          type: "array",
          items: {
            type: "string"
          }
        }
      },
      required: ["run_id", "repo_path", "role", "brief"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const agent = optionalString(args, "agent");
      const kind = optionalString(args, "kind");
      const persona = optionalString(args, "persona");
      const result = await summonAgent({
        repoPath: requiredString(args, "repo_path"),
        runId: requiredString(args, "run_id"),
        role: parseRole(requiredString(args, "role")),
        brief: requiredString(args, "brief"),
        ...(agent ? { agent: parseRoleAssignment(agent) } : {}),
        ...(kind ? { summonKind: kind } : {}),
        ...(persona ? { persona } : {}),
        constraints: optionalStringList(args, "constraints"),
        evidenceRefs: optionalStringList(args, "evidence_refs")
      });

      return {
        ...runSummary(result.run),
        summoned_role: result.role,
        summoned_agent: formatRoleAssignment(result.assignment),
        summon_kind: result.summonKind,
        advanced: result.advanced,
        stop_reason: result.stopReason,
        directive_artifact: result.directiveArtifact ? artifactSummary(result.directiveArtifact) : null,
        response_artifact: result.responseArtifact ? artifactSummary(result.responseArtifact) : null,
        provider_response_count: result.providerResponses.length,
        provider_responses: agentResponsesSummary(result.providerResponses)
      };
    })
});

const createFanoutTool = (): McpTool => ({
  definition: {
    name: "thehood_fanout",
    title: "Fan Out Same-Run TheHood Agents",
    description: "Run a bounded group of read-only same-run summons for advisory QA, critique, research, or planning evidence. Fan-out evidence is sidecar-only and cannot satisfy required verifier or runtime QA gates.",
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
        max_items: {
          type: "number",
          description: "Optional cap for this call. The runtime hard cap is 8."
        },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              role: {
                type: "string",
                enum: ["orchestrator", "planner", "researcher", "qa", "verifier", "critic"]
              },
              brief: {
                type: "string"
              },
              agent: {
                type: "string",
                description: "Optional one-call provider:model assignment, for example stub:qa."
              },
              kind: {
                type: "string",
                description: "Optional summon kind such as qa, critique, research, review, or plan."
              },
              summon_kind: {
                type: "string"
              },
              persona: {
                type: "string"
              },
              constraints: {
                type: "array",
                items: {
                  type: "string"
                }
              },
              evidence_refs: {
                type: "array",
                items: {
                  type: "string"
                }
              },
              evidenceRefs: {
                type: "array",
                items: {
                  type: "string"
                }
              }
            },
            required: ["role", "brief"]
          }
        }
      },
      required: ["run_id", "repo_path", "items"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const maxItems = optionalNumber(args, "max_items");
      const result = await fanoutAgents({
        repoPath: requiredString(args, "repo_path"),
        runId: requiredString(args, "run_id"),
        items: requiredObjectArray(args, "items").map(parseFanoutItem),
        ...(maxItems === undefined ? {} : { maxItems: Math.floor(maxItems) })
      });

      return {
        ...runSummary(result.run),
        fanout_status: result.status,
        bounds: result.bounds as unknown as JsonObject,
        fanout_artifact: artifactSummary(result.artifact),
        items: result.items.map((item) => ({
          index: item.index,
          role: item.role,
          summon_kind: item.summonKind,
          status: item.status,
          stop_reason: item.stopReason,
          agent: item.assignment ? formatRoleAssignment(item.assignment) : null,
          directive_artifact: item.directiveArtifact ? artifactSummary(item.directiveArtifact) : null,
          response_artifact: item.responseArtifact ? artifactSummary(item.responseArtifact) : null,
          provider_response_count: item.providerResponseCount,
          provider_status: item.providerStatus ?? null
        }))
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
        provider_response_count: advanced.providerResponses.length,
        provider_responses: agentResponsesSummary(advanced.providerResponses)
      };
    })
});

const createReconcileTool = (): McpTool => ({
  definition: {
    name: "thehood_reconcile",
    title: "Reconcile TheHood Run",
    description: "Reconcile a completed TheHood run by sending its progress packet to the configured planner or orchestrator after any required approval.",
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
        role: {
          type: "string",
          enum: ["planner", "orchestrator"]
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
      const repoPath = requiredString(args, "repo_path");
      const runId = requiredString(args, "run_id");
      const approval = optionalString(args, "approval") ?? "none";

      if (!["approve", "reject", "revise", "none"].includes(approval)) {
        throw new Error("approval must be approve, reject, revise, or none.");
      }

      if (approval !== "none") {
        const run = await getRun(repoPath, runId);
        const message = optionalString(args, "message") ?? approvalMessageHint(run);
        await recordApproval(repoPath, runId, approval as ApprovalDecision, message);
      }

      const roleValue = optionalString(args, "role");
      const result = await reconcileRun({
        repoPath,
        runId,
        ...(roleValue ? { role: parseRole(roleValue) } : {})
      });

      return {
        ...runSummary(result.run),
        reconciled_role: result.role,
        advanced: result.advanced,
        stop_reason: result.stopReason,
        progress_artifact: result.progressArtifact ? artifactSummary(result.progressArtifact) : null,
        reconciliation_artifact: result.reconciliationArtifact ? artifactSummary(result.reconciliationArtifact) : null,
        provider_response_count: result.providerResponses.length,
        provider_responses: agentResponsesSummary(result.providerResponses)
      };
    })
});

const createTransferPreviewTool = (): McpTool => ({
  definition: {
    name: "thehood_transfer_preview",
    title: "Preview External Transfer",
    description: "Read the latest runtime-owned external transfer manifest for a run without sending anything to a provider.",
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
      const preview = await readLatestExternalTransferManifest(run);

      return toJsonObject(preview);
    })
});

const createReadArtifactTool = (): McpTool => ({
  definition: {
    name: "thehood_read_artifact",
    title: "Read TheHood Artifact",
    description: "Read a bounded artifact attached to a run.",
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
        ref: {
          type: "string"
        },
        max_bytes: {
          type: "number"
        }
      },
      required: ["run_id", "repo_path", "ref"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const maxBytesValue = args.max_bytes;
      const maxBytes = typeof maxBytesValue === "number" && Number.isFinite(maxBytesValue)
        ? Math.max(1, Math.floor(maxBytesValue))
        : undefined;
      const result = await readRunArtifact({
        repoPath: requiredString(args, "repo_path"),
        runId: requiredString(args, "run_id"),
        ref: requiredString(args, "ref"),
        ...(maxBytes === undefined ? {} : { maxBytes })
      });

      return {
        artifact: {
          kind: result.artifact.kind,
          ref: result.artifact.ref,
          summary: result.artifact.summary
        },
        content: result.content,
        truncated: result.truncated,
        byte_length: result.byteLength
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
      const insights = toJsonObject(await getRunInsights(run));

      return {
        ...runSummary(run, insights),
        events: run.events.map((event) => ({
          created_at: event.createdAt,
          type: event.type,
          message: event.message
        }))
      };
    })
});

const createRunsTool = (): McpTool => ({
  definition: {
    name: "thehood_runs",
    title: "List TheHood Runs",
    description: "List recent TheHood runs for a repository.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo_path: {
          type: "string"
        },
        limit: {
          type: "number"
        }
      },
      required: ["repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const limitValue = args.limit;
      const limit = typeof limitValue === "number" && Number.isFinite(limitValue)
        ? Math.max(1, Math.floor(limitValue))
        : 20;
      const runs = await listRuns(requiredString(args, "repo_path"));

      return {
        runs: runs.slice(0, Math.min(limit, 100)).map((run) => runSummary(run))
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

const createRepoTreeTool = (): McpTool => ({
  definition: {
    name: "thehood_repo_tree",
    title: "List Repository Tree",
    description: "Read-only repository tree listing for connector-backed planning. Paths are relative to repo_path and secret-looking or runtime-private paths are skipped.",
    annotations: readOnlyAnnotations(),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo_path: {
          type: "string"
        },
        path: {
          type: "string",
          description: "Optional relative directory path. Defaults to repository root."
        },
        max_depth: {
          type: "number"
        },
        max_entries: {
          type: "number"
        }
      },
      required: ["repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const treePath = optionalString(args, "path");
      const maxDepth = optionalNumber(args, "max_depth");
      const maxEntries = optionalNumber(args, "max_entries");
      const result = await listRepoTree({
        repoPath: requiredString(args, "repo_path"),
        ...(treePath ? { path: treePath } : {}),
        ...(maxDepth === undefined ? {} : { maxDepth }),
        ...(maxEntries === undefined ? {} : { maxEntries })
      });

      return toJsonObject(result);
    })
});

const createRepoSearchTool = (): McpTool => ({
  definition: {
    name: "thehood_repo_search",
    title: "Search Repository",
    description: "Read-only exact text search across safe, text-like repository files. Returns file paths, line numbers, and matching lines.",
    annotations: readOnlyAnnotations(),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo_path: {
          type: "string"
        },
        query: {
          type: "string"
        },
        globs: {
          type: "array",
          items: {
            type: "string"
          }
        },
        max_results: {
          type: "number"
        },
        case_sensitive: {
          type: "boolean"
        }
      },
      required: ["repo_path", "query"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const maxResults = optionalNumber(args, "max_results");
      const caseSensitive = optionalBoolean(args, "case_sensitive");
      const result = await searchRepo({
        repoPath: requiredString(args, "repo_path"),
        query: requiredString(args, "query"),
        globs: optionalStringList(args, "globs"),
        ...(maxResults === undefined ? {} : { maxResults }),
        ...(caseSensitive === undefined ? {} : { caseSensitive })
      });

      return toJsonObject(result);
    })
});

const createRepoReadFileTool = (): McpTool => ({
  definition: {
    name: "thehood_repo_read_file",
    title: "Read Repository File",
    description: "Read-only bounded text file read from an allowed repository-relative path.",
    annotations: readOnlyAnnotations(),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo_path: {
          type: "string"
        },
        path: {
          type: "string"
        },
        offset: {
          type: "number"
        },
        max_bytes: {
          type: "number"
        }
      },
      required: ["repo_path", "path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const offset = optionalNumber(args, "offset");
      const maxBytes = optionalNumber(args, "max_bytes");
      const result = await readRepoFile({
        repoPath: requiredString(args, "repo_path"),
        path: requiredString(args, "path"),
        ...(offset === undefined ? {} : { offset }),
        ...(maxBytes === undefined ? {} : { maxBytes })
      });

      return toJsonObject(result);
    })
});

const createGitStatusTool = (): McpTool => ({
  definition: {
    name: "thehood_git_status",
    title: "Read Git Status",
    description: "Read-only git status for the repository, excluding TheHood runtime state.",
    annotations: readOnlyAnnotations(),
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
    executeTool(argumentsValue, async (args) =>
      toJsonObject(await getRepoGitStatus(requiredString(args, "repo_path")))
    )
});

const createGitDiffTool = (): McpTool => ({
  definition: {
    name: "thehood_git_diff",
    title: "Read Git Diff",
    description: "Read-only bounded git diff for the repository or a single repository-relative path.",
    annotations: readOnlyAnnotations(),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo_path: {
          type: "string"
        },
        path: {
          type: "string"
        },
        max_bytes: {
          type: "number"
        }
      },
      required: ["repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const diffPath = optionalString(args, "path");
      const maxBytes = optionalNumber(args, "max_bytes");
      const result = await getRepoGitDiff({
        repoPath: requiredString(args, "repo_path"),
        ...(diffPath ? { path: diffPath } : {}),
        ...(maxBytes === undefined ? {} : { maxBytes })
      });

      return toJsonObject(result);
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
  createSummonTool(),
  createFanoutTool(),
  createContinueTool(),
  createReconcileTool(),
  createTransferPreviewTool(),
  createStatusTool(),
  createRunsTool(),
  createReadArtifactTool(),
  createCaptureEvidenceTool(),
  createRepoTreeTool(),
  createRepoSearchTool(),
  createRepoReadFileTool(),
  createGitStatusTool(),
  createGitDiffTool(),
  createAbortTool()
];

export const findTool = (name: string): McpTool | undefined =>
  mcpTools.find((tool) => tool.definition.name === name);
