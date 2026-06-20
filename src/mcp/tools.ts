import { loadConfig, writeConfig } from "../runtime/config.js";
import { inspectRuntimeHealth } from "../runtime/doctor.js";
import { buildAgentBoard, type AgentBoard, type AgentBoardAction, type AgentBoardCard } from "../runtime/agentBoard.js";
import { buildAgentBoardArtifact } from "../runtime/agentBoardArtifact.js";
import { abortRun, createRun, getRun, listRuns, recordApproval } from "../runtime/runtime.js";
import { captureGitEvidence } from "../runtime/gitEvidence.js";
import { fanoutAgents, type FanoutItemInput } from "../runtime/fanout.js";
import { advanceRun } from "../runtime/loop.js";
import { runAutopilotLoop } from "../runtime/loopRunner.js";
import { assertRoleInvariants } from "../runtime/permissions.js";
import { readRunArtifact } from "../runtime/artifacts.js";
import { readLatestExternalTransferManifest } from "../runtime/externalTransfer.js";
import { boundAgentMarkdownPayloads } from "../providers/markdownPayload.js";
import { codexCliModelAvailable, resolveCodexCliModel } from "../providers/codexCliModels.js";
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
import { buildRoleRoster } from "../runtime/roleRoster.js";
import { getRunInsights, type RunInsights } from "../runtime/runInsights.js";
import { inspectRemoteRepoContext } from "../runtime/remoteRepoContext.js";
import { summonAgent } from "../runtime/summons.js";
import type { AgentResponse } from "../providers/types.js";
import type {
  ApprovalDecision,
  JsonObject,
  JsonValue,
  CrewLane,
  OperatorNextAction,
  RoleMap,
  RunMode,
  RunRecord,
  RuntimeRole
} from "../runtime/types.js";
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
type HostResponseDetail = "summary" | "full";
type ModelAccessContextKind = "repo_context" | "progress_packet" | "no_repo_context" | "connector_handoff";

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

const compactArtifactLimit = 20;
const compactEventLimit = 5;
const compactNextActionLimit = 8;
const compactBoardCardLimit = 4;
const compactProviderResponseLimit = 5;
const compactCycleLimit = 3;
const compactTextLimit = 600;

const detailProperty = {
  type: "string",
  enum: ["summary", "full"],
  description: "summary is compact and refs-only by default; full returns the legacy verbose payload."
};

const parseResponseDetail = (args: JsonObject): HostResponseDetail => {
  const detail = optionalString(args, "detail") ?? "summary";

  if (detail !== "summary" && detail !== "full") {
    throw new Error("detail must be summary or full when provided.");
  }

  return detail;
};

const truncateText = (value: string, maxLength = compactTextLimit): string =>
  value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 14))}...[truncated]`;

const trimTerminalPunctuation = (value: string): string =>
  value.replace(/[.!?]+$/g, "");

const copyableTextBlock = (value: string): string =>
  `\`\`\`text\n${value}\n\`\`\``;

const jsonObjectValue = (value: JsonValue | undefined): JsonObject | undefined =>
  value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;

const latestItems = <T>(items: T[], limit: number): { items: T[]; omitted: number } => {
  const omitted = Math.max(0, items.length - limit);
  return {
    items: items.slice(omitted),
    omitted
  };
};

const artifactCounts = (artifacts: RunRecord["artifacts"]): JsonObject =>
  artifacts.reduce<JsonObject>((counts, artifact) => {
    const current = counts[artifact.kind];

    return {
      ...counts,
      [artifact.kind]: (typeof current === "number" ? current : 0) + 1
    };
  }, {});

const hostArtifactSummaries = (run: RunRecord): RunRecord["artifacts"] => {
  const evidenceArtifacts = run.artifacts.filter((artifact) => artifact.kind !== "log" && artifact.kind !== "directive");
  return latestItems(evidenceArtifacts, compactArtifactLimit).items;
};

const compactRunEvents = (run: RunRecord): JsonObject => {
  const latest = latestItems(run.events, compactEventLimit);

  return {
    count: run.events.length,
    omitted: latest.omitted,
    latest: latest.items.map((event) => ({
      id: event.id,
      created_at: event.createdAt,
      type: event.type,
      message: truncateText(event.message)
    }))
  };
};

const compactNextAction = (action: OperatorNextAction): JsonObject => ({
  action: action.action,
  label: truncateText(action.label),
  description: truncateText(action.description),
  owner: compactOwner(action.owner),
  owner_label: truncateText(action.owner.label),
  blocking: action.blocking,
  required: action.required,
  state: action.state,
  reason: truncateText(action.reason),
  generatedAt: action.generatedAt,
  ...(action.tool ? { tool: action.tool } : {}),
  ...(action.mcpToolHint ? { mcp_tool_hint: action.mcpToolHint } : {}),
  ...(action.arguments ? { arguments: action.arguments } : {}),
  ...(action.artifact ? { artifact: action.artifact as unknown as JsonObject } : {}),
  artifactRefs: action.artifactRefs.slice(0, 3),
  eventRefs: action.eventRefs.slice(0, 3)
});

const compactNextActions = (run: RunRecord): JsonObject[] =>
  deriveOperatorNextActions(run)
    .slice(0, compactNextActionLimit)
    .map(compactNextAction);

const compactAgentResponse = (response: AgentResponse): JsonObject => ({
  status: response.status,
  summary: truncateText(response.summary),
  data: boundAgentMarkdownPayloads(response.data, 1_000)
});

const agentResponsesSummary = (responses: AgentResponse[]): JsonObject[] =>
  latestItems(responses, compactProviderResponseLimit).items.map(compactAgentResponse);

const compactProviderExecution = (execution: RunInsights["recentProviderExecutions"][number]): JsonObject => ({
  artifact: execution.artifact as unknown as JsonObject,
  ...(execution.role ? { role: execution.role } : {}),
  ...(execution.provider ? { provider: execution.provider } : {}),
  ...(execution.model ? { model: execution.model } : {}),
  ...(execution.commandMode ? { commandMode: execution.commandMode } : {}),
  ...(execution.workspaceMode ? { workspaceMode: execution.workspaceMode } : {}),
  ...(execution.sandbox ? { sandbox: execution.sandbox } : {}),
  ...(execution.permissionMode ? { permissionMode: execution.permissionMode } : {}),
  ...(execution.exitCode !== undefined ? { exitCode: execution.exitCode } : {}),
  ...(execution.timedOut !== undefined ? { timedOut: execution.timedOut } : {}),
  ...(execution.durationMs !== undefined ? { durationMs: execution.durationMs } : {}),
  ...(execution.stdoutRef ? { stdoutRef: execution.stdoutRef } : {}),
  ...(execution.stderrRef ? { stderrRef: execution.stderrRef } : {}),
  ...(execution.responseParsed !== undefined ? { responseParsed: execution.responseParsed } : {}),
  ...(execution.responseStatus ? { responseStatus: execution.responseStatus } : {})
});

const compactDecision = (decision: JsonObject): JsonObject => ({
  ...(typeof decision.action === "string" ? { action: decision.action } : {}),
  ...(typeof decision.reason === "string" ? { reason: truncateText(decision.reason, 240) } : {}),
  ...(typeof decision.delegateTo === "string" ? { delegateTo: decision.delegateTo } : {}),
  ...(typeof decision.nextRole === "string" ? { nextRole: decision.nextRole } : {}),
  ...(typeof decision.requiresMoreEvidence === "boolean" ? { requiresMoreEvidence: decision.requiresMoreEvidence } : {}),
  ...(typeof decision.sliceName === "string" ? { sliceName: decision.sliceName } : {}),
  ...(typeof decision.reasonCode === "string" ? { reasonCode: decision.reasonCode } : {}),
  ...(typeof decision.callCritic === "boolean" ? { callCritic: decision.callCritic } : {}),
  ...(Array.isArray(decision.targetPaths) ? { targetPathCount: decision.targetPaths.length } : {}),
  ...(Array.isArray(decision.requestedPaths) ? { requestedPathCount: decision.requestedPaths.length } : {}),
  ...(Array.isArray(decision.evidenceRefs) ? { evidenceRefCount: decision.evidenceRefs.length } : {}),
  ...(Array.isArray(decision.artifactRefs) ? { artifactRefCount: decision.artifactRefs.length } : {}),
  ...(Array.isArray(decision.sourceRoles) ? { sourceRoles: decision.sourceRoles.slice(0, 5) as JsonValue[] } : {}),
  ...(Array.isArray(decision.acceptanceCriteria) ? { acceptanceCriteriaCount: decision.acceptanceCriteria.length } : {}),
  ...(typeof decision.markdownTruncated === "boolean" ? { markdownTruncated: decision.markdownTruncated } : {}),
  ...(typeof decision.markdownCharLength === "number" ? { markdownCharLength: decision.markdownCharLength } : {})
});

const compactLatestAgentResponse = (response: RunInsights["latestAgentResponse"]): JsonObject | undefined => {
  if (!response) {
    return undefined;
  }

  return {
    artifact: response.artifact as unknown as JsonObject,
    status: response.status,
    summary: truncateText(response.summary),
    ...(response.primaryOutputKey ? { primaryOutputKey: response.primaryOutputKey } : {}),
    ...(response.decision ? { decision: compactDecision(response.decision) } : {}),
    ...(response.markdown
      ? {
          markdown: {
            field: response.markdown.field,
            preview: truncateText(response.markdown.preview, 800),
            truncated: response.markdown.truncated,
            charLength: response.markdown.charLength
          }
        }
      : {})
  };
};

const compactOwner = (owner: {
  kind: string;
  label: string;
  role?: RuntimeRole;
  provider?: string;
  model?: string;
  assignment?: string;
  readOnly?: boolean;
}): JsonObject => ({
  kind: owner.kind,
  label: truncateText(owner.label),
  ...(owner.role ? { role: owner.role } : {}),
  ...(owner.provider ? { provider: owner.provider } : {}),
  ...(owner.model ? { model: owner.model } : {}),
  ...(owner.assignment ? { assignment: owner.assignment } : {}),
  ...(owner.readOnly !== undefined ? { readOnly: owner.readOnly } : {})
});

const compactCrewLaneStatus = (lane: CrewLane): JsonObject => ({
  id: lane.id,
  kind: lane.kind,
  status: lane.status,
  required: lane.required,
  blocking: lane.blocking,
  ...(lane.reviewLaneId ? { reviewLaneId: lane.reviewLaneId } : {}),
  ...(lane.sidecarOnly !== undefined ? { sidecarOnly: lane.sidecarOnly } : {})
});

const compactInsightAction = (action: OperatorNextAction): JsonObject => ({
  action: action.action,
  label: truncateText(action.label),
  ...(action.tool ? { tool: action.tool } : {}),
  artifactRefs: action.artifactRefs.slice(0, 1)
});

const compactCanonicalMemory = (memory: JsonObject): JsonObject => {
  const currentRun = jsonObjectValue(memory.currentRun);

  return {
    ...(memory.kind === undefined ? {} : { kind: memory.kind }),
    ...(memory.artifactBodyPolicy === undefined ? {} : { artifactBodyPolicy: memory.artifactBodyPolicy }),
    ...(memory.ignoreProviderSessionContext === undefined
      ? {}
      : { ignoreProviderSessionContext: memory.ignoreProviderSessionContext }),
    currentRun: currentRun
      ? {
          ...(currentRun.runId === undefined ? {} : { runId: currentRun.runId }),
          ...(currentRun.state === undefined ? {} : { state: currentRun.state }),
          ...(currentRun.artifacts === undefined ? {} : { artifacts: currentRun.artifacts })
        } as JsonObject
      : {}
  };
};

const selectCompactCrewLanes = (lanes: CrewLane[]): CrewLane[] => {
  const selected = lanes.filter((lane) =>
    lane.blocking ||
    lane.required ||
    lane.status === "in_progress" ||
    lane.status === "satisfied" ||
    lane.id === "crew-lane-complete"
  );
  return (selected.length > 0 ? selected : lanes).slice(0, compactBoardCardLimit);
};

const compactFanout = (fanout: RunInsights["latestFanout"]): JsonObject | undefined => {
  if (!fanout) {
    return undefined;
  }

  return {
    artifact: fanout.artifact as unknown as JsonObject,
    ...(fanout.status ? { status: fanout.status } : {}),
    ...(fanout.requestedItems !== undefined ? { requestedItems: fanout.requestedItems } : {}),
    ...(fanout.executedItems !== undefined ? { executedItems: fanout.executedItems } : {}),
    ...(fanout.maxItems !== undefined ? { maxItems: fanout.maxItems } : {}),
    sidecarOnly: fanout.sidecarOnly,
    canSatisfyRequiredGates: fanout.canSatisfyRequiredGates,
    items: fanout.items.slice(0, compactBoardCardLimit).map((item) => ({ ...item }))
  };
};

const compactInsights = (insights: RunInsights): JsonObject => {
  const latestAgentResponse = compactLatestAgentResponse(insights.latestAgentResponse);
  const latestFanout = compactFanout(insights.latestFanout);

  return {
    ...(latestAgentResponse ? { latestAgentResponse } : {}),
    ...(insights.finalReport ? { finalReport: insights.finalReport as unknown as JsonObject } : {}),
    ...(insights.latestCriticTrigger ? { latestCriticTrigger: insights.latestCriticTrigger as unknown as JsonObject } : {}),
    ...(insights.latestRevisionPacket ? { latestRevisionPacket: insights.latestRevisionPacket as unknown as JsonObject } : {}),
    ...(insights.latestReviewRouting ? { latestReviewRouting: insights.latestReviewRouting as unknown as JsonObject } : {}),
    ...(insights.latestProviderExecution ? { latestProviderExecution: compactProviderExecution(insights.latestProviderExecution) } : {}),
    recentProviderExecutionCount: insights.recentProviderExecutions.length,
    ...(latestFanout ? { latestFanout } : {}),
    ...(insights.latestProgressPacket ? { latestProgressPacket: insights.latestProgressPacket as unknown as JsonObject } : {}),
    ...(insights.latestReconciliation ? { latestReconciliation: insights.latestReconciliation as unknown as JsonObject } : {}),
    ...(insights.latestRepoContext ? { latestRepoContext: insights.latestRepoContext as unknown as JsonObject } : {}),
    ...(insights.latestRemoteRepoContext ? { latestRemoteRepoContext: insights.latestRemoteRepoContext as unknown as JsonObject } : {}),
    ...(insights.latestTransferManifest ? { latestTransferManifest: insights.latestTransferManifest as unknown as JsonObject } : {}),
    ...(insights.canonicalMemory
      ? {
          canonicalMemory: compactCanonicalMemory(insights.canonicalMemory)
        }
      : {}),
    crewLanes: {
      kind: insights.crewLanes.kind,
      laneCount: insights.crewLanes.lanes.length,
      blockerCount: insights.crewLanes.blockers.length,
      lanes: selectCompactCrewLanes(insights.crewLanes.lanes).map(compactCrewLaneStatus)
    },
    revisionTrail: {
      kind: insights.revisionTrail.kind,
      itemCount: insights.revisionTrail.items.length,
      items: insights.revisionTrail.items.slice(0, compactBoardCardLimit) as unknown as JsonObject[]
    },
    loopResponsibilities: {
      kind: insights.loopResponsibilities.kind,
      responsibilityCount: insights.loopResponsibilities.responsibilities.length,
      blockerCount: insights.loopResponsibilities.blockers.length
    },
    reviewLaneCount: insights.reviewLanes.length,
    operatorNextActionCount: insights.operatorNextActions.length,
    operatorNextActions: insights.operatorNextActions.slice(0, compactNextActionLimit).map(compactInsightAction),
    ...(insights.latestHandoff ? { latestHandoff: insights.latestHandoff as unknown as JsonObject } : {}),
    handoffCount: insights.handoffTimeline.length,
    recentAutopilotApprovalCount: insights.recentAutopilotApprovals.length,
    issues: insights.issues.slice(0, 5)
  };
};

const compactBoardAction = (action: AgentBoardAction): JsonObject => ({
  action: action.action,
  label: truncateText(action.label),
  ownerLabel: truncateText(action.ownerLabel),
  blocking: action.blocking,
  required: action.required,
  state: action.state,
  ...(action.tool ? { tool: action.tool } : {}),
  ...(action.mcpToolHint ? { mcpToolHint: action.mcpToolHint } : {}),
  artifactRefs: action.artifactRefs.slice(0, 3),
  eventRefs: action.eventRefs.slice(0, 3)
});

const compactBoardCard = (card: AgentBoardCard): JsonObject => ({
  id: card.id,
  role: card.role,
  assignmentLabel: card.assignmentLabel,
  status: card.status,
  readOnly: card.readOnly,
  ...(card.provider ? { provider: card.provider } : {}),
  ...(card.model ? { model: card.model } : {}),
  ...(card.issues.length > 0 ? { issues: card.issues.slice(0, 3) } : {}),
  ...(card.run
    ? {
        run: {
          runId: card.run.runId,
          state: card.run.state,
          mode: card.run.mode,
          ...(card.run.currentLane ? { currentLane: card.run.currentLane } : {}),
          ...(card.run.laneStatus ? { laneStatus: card.run.laneStatus } : {}),
          ...(card.run.laneSummary ? { laneSummary: truncateText(card.run.laneSummary) } : {}),
          ...(card.run.required !== undefined ? { required: card.run.required } : {}),
          ...(card.run.blocking !== undefined ? { blocking: card.run.blocking } : {}),
          ...(card.run.canSatisfyGate !== undefined ? { canSatisfyGate: card.run.canSatisfyGate } : {}),
          ...(card.run.satisfiesRequired !== undefined ? { satisfiesRequired: card.run.satisfiesRequired } : {}),
          ...(card.run.sidecarOnly !== undefined ? { sidecarOnly: card.run.sidecarOnly } : {}),
          artifactRefs: card.run.artifactRefs.slice(0, 1),
          eventRefs: card.run.eventRefs.slice(0, 1),
          handoffRefs: card.run.handoffRefs.slice(0, 1)
        }
      }
    : {})
});

const compactAgentBoard = (board: AgentBoard): JsonObject => {
  const visibleCards = board.cards.filter((card) => card.status !== "unassigned" || card.issues.length > 0);
  const selectedCards = visibleCards.length > 0 ? visibleCards : board.cards;
  const latestCards = latestItems(selectedCards, compactBoardCardLimit);
  const latestActions = latestItems(board.actions, compactNextActionLimit);

  return {
    schemaVersion: board.schemaVersion,
    kind: board.kind,
    scope: board.scope,
    repoPath: board.repoPath,
    ...(board.runId ? { runId: board.runId } : {}),
    ...(board.runState ? { runState: board.runState } : {}),
    ...(board.runMode ? { runMode: board.runMode } : {}),
    summary: board.summary,
    cardCount: board.cards.length,
    visibleCardCount: selectedCards.length,
    omittedCards: latestCards.omitted,
    cards: latestCards.items.map(compactBoardCard),
    actionCount: board.actions.length,
    omittedActions: latestActions.omitted,
    actions: latestActions.items.map(compactBoardAction),
    notes: board.notes.slice(0, 2)
  };
};

const fullRunSummary = (run: RunRecord, insights?: JsonObject): JsonObject => ({
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

const compactRunSummary = (run: RunRecord, insights?: RunInsights): JsonObject => {
  const compactArtifactsForHost = hostArtifactSummaries(run);

  return {
    run_id: run.runId,
    status: run.state,
    mode: run.mode,
    preferred_role: run.preferredRole ?? null,
    repo_path: run.repoPath,
    goal: truncateText(run.userGoal),
    roles: roleSummary(run.roleMapping),
    approval_required: run.approvalRequired,
    approval_reason: run.approvalReason ? truncateText(run.approvalReason) : null,
    stop_reason: run.stopReason ? truncateText(run.stopReason) : null,
    artifact_count: run.artifacts.length,
    artifact_counts: artifactCounts(run.artifacts),
    artifacts_omitted: Math.max(0, run.artifacts.filter((artifact) => artifact.kind !== "log" && artifact.kind !== "directive").length - compactArtifactsForHost.length),
    artifacts: compactArtifactsForHost.map(artifactSummary),
    event_count: run.events.length,
    approval_event_count: run.approvalEvents.length,
    tool_event_count: run.toolEvents.length,
    events: compactRunEvents(run),
    ...(insights ? { insights: compactInsights(insights) } : {}),
    next_actions: compactNextActions(run),
    host_response: {
      detail: "summary",
      artifact_body_policy: "refs_only",
      full_detail: "Pass detail=full for the legacy verbose payload or read exact artifact refs with thehood_read_artifact."
    }
  };
};

const runSummary = (
  run: RunRecord,
  insights?: RunInsights,
  detail: HostResponseDetail = "summary"
): JsonObject =>
  detail === "full" ? fullRunSummary(run, insights ? toJsonObject(insights) : undefined) : compactRunSummary(run, insights);

const runLoopSummary = (
  result: Awaited<ReturnType<typeof runAutopilotLoop>>,
  detail: HostResponseDetail = "summary"
): JsonObject => {
  const latestCycles = latestItems(result.cycles, compactCycleLimit);

  return {
    ...runSummary(result.run, undefined, detail),
    advanced: result.advanced,
    stop_kind: result.stopKind,
    stop_reason: result.stopReason,
    ...(detail === "full"
      ? { cycles: result.cycles as unknown as JsonObject[] }
      : {
          cycle_count: result.cycles.length,
          cycles_omitted: latestCycles.omitted,
          cycles: latestCycles.items as unknown as JsonObject[]
        }),
    max_cycles: result.maxCycles,
    max_steps_per_cycle: result.maxStepsPerCycle,
    provider_response_count: result.providerResponses.length,
    provider_responses: agentResponsesSummary(result.providerResponses)
  };
};

const toJsonObject = (value: unknown): JsonObject =>
  JSON.parse(JSON.stringify(value)) as JsonObject;

const agentBoardForRun = async (
  repoPath: string,
  runId?: string,
  existingRun?: Awaited<ReturnType<typeof getRun>>,
  existingInsights?: Awaited<ReturnType<typeof getRunInsights>>
): Promise<Awaited<ReturnType<typeof buildAgentBoard>>> => {
  const config = await loadConfig(repoPath);
  const health = await inspectRuntimeHealth(config);
  const roster = buildRoleRoster(config, health);

  if (!runId) {
    return buildAgentBoard({ repoPath, roster });
  }

  const run = existingRun ?? await getRun(repoPath, runId);
  const insights = existingInsights ?? await getRunInsights(run);

  return buildAgentBoard({ repoPath, roster, run, insights });
};

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

const optionalPositiveInteger = (source: JsonObject, key: string): number | undefined => {
  const value = optionalNumber(source, key);

  if (value === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer when provided.`);
  }

  return value;
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
        },
        auto_loop: {
          type: "boolean",
          description: "When true, create the run and immediately advance it through the headless loop until a real stop condition."
        },
        max_cycles: {
          type: "number",
          description: "Optional positive integer for auto_loop. Defaults to 8."
        },
        max_steps_per_cycle: {
          type: "number",
          description: "Optional positive integer for auto_loop. Defaults to 10."
        },
        detail: detailProperty
      },
      required: ["goal", "repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const detail = parseResponseDetail(args);
      const run = await createRun({
        repoPath: requiredString(args, "repo_path"),
        goal: requiredString(args, "goal"),
        mode: "plan",
        roleOverrides: roleOverrideFromOrchestrator(optionalString(args, "orchestrator")),
        constraints: optionalStringList(args, "constraints")
      });

      if (optionalBoolean(args, "auto_loop") === true) {
        const maxCycles = optionalPositiveInteger(args, "max_cycles");
        const maxStepsPerCycle = optionalPositiveInteger(args, "max_steps_per_cycle");
        const result = await runAutopilotLoop({
          repoPath: run.repoPath,
          runId: run.runId,
          ...(maxCycles === undefined ? {} : { maxCycles }),
          ...(maxStepsPerCycle === undefined ? {} : { maxStepsPerCycle })
        });

        return {
          ...runLoopSummary(result, detail),
          summary: "TheHood created the plan run and advanced it through the headless loop."
        };
      }

      return {
        ...runSummary(run, undefined, detail)
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
        },
        auto_loop: {
          type: "boolean",
          description: "When true, create the run and immediately advance it through the headless loop until a real stop condition."
        },
        max_cycles: {
          type: "number",
          description: "Optional positive integer for auto_loop. Defaults to 8."
        },
        max_steps_per_cycle: {
          type: "number",
          description: "Optional positive integer for auto_loop. Defaults to 10."
        },
        detail: detailProperty
      },
      required: ["goal", "repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const detail = parseResponseDetail(args);
      const run = await createRun({
        repoPath: requiredString(args, "repo_path"),
        goal: requiredString(args, "goal"),
        mode: optionalRunMode(args, "mode", "implement"),
        roleOverrides: optionalRoleMapping(args),
        constraints: optionalStringList(args, "constraints")
      });

      if (optionalBoolean(args, "auto_loop") === true) {
        const maxCycles = optionalPositiveInteger(args, "max_cycles");
        const maxStepsPerCycle = optionalPositiveInteger(args, "max_steps_per_cycle");
        const result = await runAutopilotLoop({
          repoPath: run.repoPath,
          runId: run.runId,
          ...(maxCycles === undefined ? {} : { maxCycles }),
          ...(maxStepsPerCycle === undefined ? {} : { maxStepsPerCycle })
        });

        return {
          ...runLoopSummary(result, detail),
          summary: "TheHood created the run and advanced it through the headless loop."
        };
      }

      return {
        ...runSummary(run, undefined, detail),
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
        roster: toJsonObject(buildRoleRoster(config, health)),
        health: toJsonObject(health)
      };
    })
});

const modelAccessContextKinds = new Set<ModelAccessContextKind>([
  "repo_context",
  "progress_packet",
  "no_repo_context",
  "connector_handoff"
]);

const parseModelAccessContextKind = (value: string | undefined): ModelAccessContextKind => {
  const contextKind = value ?? "repo_context";

  if (modelAccessContextKinds.has(contextKind as ModelAccessContextKind)) {
    return contextKind as ModelAccessContextKind;
  }

  throw new Error("context_kind must be repo_context, progress_packet, no_repo_context, or connector_handoff.");
};

const modelAccessContextLabel = (contextKind: ModelAccessContextKind): string => {
  switch (contextKind) {
    case "repo_context":
      return "repo context";
    case "progress_packet":
      return "progress packet";
    case "connector_handoff":
      return "connector handoff";
    case "no_repo_context":
      return "no repo context";
  }
};

const modelAccessDisclosure = (contextKind: ModelAccessContextKind): JsonObject => {
  switch (contextKind) {
    case "repo_context":
      return {
        context_kind: contextKind,
        may_leave_local_runtime:
          "Repo path, selected file excerpts, git evidence, run artifacts, and role directives may be disclosed only by a later approved model-backed call.",
        not_sent_by_this_tool:
          "This preflight is local-only and does not call external models or include file bodies."
      };
    case "progress_packet":
      return {
        context_kind: contextKind,
        may_leave_local_runtime:
          "Runtime progress, memory, reconciliation, artifact refs, and compact evidence summaries may be disclosed only by a later approved model-backed call.",
        not_sent_by_this_tool:
          "This preflight is local-only and does not call external models or include progress packet bodies."
      };
    case "connector_handoff":
      return {
        context_kind: contextKind,
        may_leave_local_runtime:
          "A connected model host may request bounded repo or run evidence through TheHood MCP tools after the user enables that connector.",
        not_sent_by_this_tool:
          "This preflight is local-only and does not open a connector or send repo context."
      };
    case "no_repo_context":
      return {
        context_kind: contextKind,
        may_leave_local_runtime:
          "Only the abstract prompt should be sent. Do not include repo path, file excerpts, private run artifacts, memory packets, or progress packets.",
        not_sent_by_this_tool:
          "This preflight is local-only and does not call external models."
      };
  }
};

const modelAccessModelInfo = (
  provider: Awaited<ReturnType<typeof inspectRuntimeHealth>>["providers"][number] | undefined,
  model: string
): JsonObject => {
  if (!provider) {
    return {
      model_status: "unavailable",
      model_available: false
    };
  }

  if (provider.id === "codex-cli" && provider.modelDiscovery) {
    const available = codexCliModelAvailable(model, provider.modelDiscovery);
    const resolvedModel = provider.modelDiscovery.status === "available"
      ? resolveCodexCliModel(model, provider.modelDiscovery)
      : undefined;

    return {
      model_status: available === true ? "available" : available === false ? "unavailable" : "unknown",
      ...(available === undefined ? {} : { model_available: available }),
      ...(resolvedModel ? { resolved_model: resolvedModel } : {}),
      model_discovery_status: provider.modelDiscovery.status,
      model_discovery_issues: provider.modelDiscovery.issues
    };
  }

  if (provider.models.includes(model)) {
    return {
      model_status: "listed",
      model_available: true
    };
  }

  if (provider.modelPolicy === "passthrough") {
    return {
      model_status: "passthrough",
      model_available: null
    };
  }

  return {
    model_status: "unavailable",
    model_available: false
  };
};

const modelAccessRepoVisibility = (
  inspection: Awaited<ReturnType<typeof inspectRemoteRepoContext>>
): JsonObject => {
  const remoteReady = Boolean(inspection.githubRemote && inspection.commit && inspection.clean && inspection.pushed);
  const userChoices: JsonObject[] = remoteReady
    ? [
        {
          id: "use_remote_github_refs",
          label: "Use remote GitHub refs",
          recommended: true
        },
        {
          id: "approve_local_context_transfer",
          label: "Approve local context only if remote evidence is insufficient",
          recommended: false
        },
        {
          id: "cancel_external_model_access",
          label: "Cancel external model access",
          recommended: false
        }
      ]
    : [
        {
          id: "commit_push_checkpoint_then_remote",
          label: "Commit and push checkpoint, then use remote repo",
          recommended: true
        },
        {
          id: "approve_local_context_transfer",
          label: "Approve bounded local context or diff transfer",
          recommended: false
        },
        {
          id: "abstract_no_repo_context_prompt",
          label: "Use no-repo-context strategy",
          recommended: false
        },
        {
          id: "cancel_external_model_access",
          label: "Cancel external model access",
          recommended: false
        }
      ];

  return {
    kind: "repo_visibility",
    repo_path: inspection.repoPath,
    clean: inspection.clean,
    pushed: inspection.pushed,
    status_path_count: inspection.statusPathCount,
    status_paths: inspection.statusPaths,
    reasons: inspection.reasons,
    github_remote: inspection.githubRemote
      ? {
          name: inspection.githubRemote.name,
          owner: inspection.githubRemote.owner,
          repo: inspection.githubRemote.repo,
          url: inspection.githubRemote.url,
          normalized_url: inspection.githubRemote.normalizedUrl
        }
      : null,
    branch: inspection.branch ?? null,
    commit: inspection.commit ?? null,
    upstream: inspection.upstream ?? null,
    upstream_commit: inspection.upstreamCommit ?? null,
    default_gate: remoteReady ? "remote_github_refs" : "user_choice_required",
    default_route: remoteReady
      ? "Use remote GitHub refs at the exact commit when the provider supports it; do not send local file contents through Codex."
      : "Ask the user to commit and push a checkpoint, explicitly approve local context/diff transfer, use no-repo-context strategy, or cancel.",
    user_choices: userChoices
  };
};

const githubRemoteReady = (repoVisibility: JsonObject): boolean =>
  repoVisibility.default_gate === "remote_github_refs";

const modelAccessRemoteRepoAccess = (providerId: string, repoVisibility: JsonObject): JsonObject => {
  if (providerId === "chatgpt-web") {
    return {
      route: "github_connector",
      status: githubRemoteReady(repoVisibility) ? "default" : "available_after_clean_pushed_checkpoint",
      description: githubRemoteReady(repoVisibility)
        ? "Use ChatGPT Pro's GitHub connector at the exact remote commit. No local file contents need to be sent through Codex."
        : "Commit and push the local checkout first, then use ChatGPT Pro's GitHub connector at the exact remote commit."
    };
  }

  return {
    route: "provider_specific_or_local",
    status: "not_verified_by_thehood",
    description:
      "TheHood does not yet have a verified remote GitHub connector route for this provider. Use a provider-specific remote repo workflow if available, or choose explicit local context approval."
  };
};

const modelAccessDestination = (
  assignmentText: string,
  health: Awaited<ReturnType<typeof inspectRuntimeHealth>>,
  contextKind: ModelAccessContextKind,
  repoVisibility: JsonObject
): JsonObject => {
  const assignment = parseRoleAssignment(assignmentText);
  const provider = health.providers.find((candidate) => candidate.id === assignment.provider);
  const issues = provider?.issues ?? [`provider_not_configured:${assignment.provider}`];
  const ready = Boolean(provider?.enabled && provider.implemented && issues.length === 0);

  return {
    assignment: formatRoleAssignment(assignment),
    provider: assignment.provider,
    model: assignment.model,
    status: ready ? "runtime_ready_host_may_still_block" : "not_ready",
    context_kind: contextKind,
    enabled: provider?.enabled ?? false,
    implemented: provider?.implemented ?? false,
    access_modes: provider?.accessModes ?? [],
    default_access_mode: provider?.defaultAccessMode ?? null,
    model_policy: provider?.modelPolicy ?? "unknown",
    command: provider?.command ?? null,
    command_found: provider?.commandFound ?? null,
    ...modelAccessModelInfo(provider, assignment.model),
    remote_repo_access: modelAccessRemoteRepoAccess(assignment.provider, repoVisibility),
    issues
  };
};

const modelAccessRecommendedPaths = (
  destinations: JsonObject[],
  contextKind: ModelAccessContextKind,
  repoVisibility: JsonObject
): JsonObject[] => {
  const allReady = destinations.every((destination) => destination.status === "runtime_ready_host_may_still_block");
  const hasChatGptWeb = destinations.some((destination) => destination.provider === "chatgpt-web");
  const remoteReady = githubRemoteReady(repoVisibility);
  const paths: JsonObject[] = [
    ...(remoteReady
      ? [
          {
            id: "use_remote_github_refs",
            status: hasChatGptWeb ? "default_for_chatgpt_web" : "available_if_provider_can_inspect_remote",
            description:
              "Use the clean pushed GitHub repo at the exact commit. Do not send local file contents through Codex."
          }
        ]
      : [
          {
            id: "commit_push_checkpoint_then_remote",
            status: "recommended_before_external_code_review",
            description:
              "Commit and push the local checkout first so remote-capable providers can inspect the exact repo state without Codex sending local file contents."
          },
          {
            id: "approve_local_context_transfer",
            status: "requires_user_decision",
            description:
              "Approve sending bounded local repo context, diff, or progress evidence to the selected model provider when the user does not want to checkpoint and push first."
          }
        ]),
    {
      id: "approve_packet_then_call_models",
      status: remoteReady && hasChatGptWeb ? "not_needed_for_chatgpt_web_remote_default" : allReady ? "runtime_ready_host_may_still_block" : "not_ready",
      description:
        "Use the approval packet copy once, then run the model-backed TheHood consult, fan-out, or orchestration call. Do not invent a new long approval sentence after a host-policy rejection."
    },
    {
      id: "abstract_no_repo_context_prompt",
      status: contextKind === "no_repo_context" ? "preferred" : "safe_when_repo_context_is_not_needed",
      description:
        "Ask the strategic question without repo path, file excerpts, run artifacts, memory packets, progress packets, or private project context."
    },
    {
      id: "runtime_only_status",
      status: "always_available",
      description:
        "Use TheHood doctor, status, artifact, repo gateway, and agent-board tools to inspect local evidence without calling external model providers."
    },
    {
      id: "cancel_external_model_access",
      status: "always_available",
      description:
        "Do not call external model providers for this request."
    }
  ];

  if (hasChatGptWeb) {
    paths.splice(1, 0, {
      id: "chatgpt_mcp_connector",
      status: "recommended_when_codex_blocks_chatgpt_web_disclosure",
      description:
        "Open ChatGPT with TheHood as an MCP connector so ChatGPT requests bounded repo/run evidence through TheHood tools instead of Codex sending a prebuilt repo context."
    });
  }

  return paths;
};

const createModelAccessTool = (): McpTool => ({
  definition: {
    name: "thehood_model_access",
    title: "Inspect TheHood Model Access Packet",
    description:
      "Local-only preflight for external model-backed TheHood calls. This does not call providers or send repo context; it reports repo visibility, remote GitHub readiness, a compact approval packet, and fallback paths when Codex host policy may block disclosure.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo_path: {
          type: "string"
        },
        agents: {
          type: "array",
          items: {
            type: "string",
            description: "Provider:model assignment, for example claude-code:opus or codex-cli:gpt-5.5."
          }
        },
        purpose: {
          type: "string",
          description: "Optional local-only purpose to include in the approval packet."
        },
        context_kind: {
          type: "string",
          enum: ["repo_context", "progress_packet", "no_repo_context", "connector_handoff"],
          description: "The disclosure shape expected for the later model-backed call."
        },
        constraints: {
          type: "array",
          items: {
            type: "string"
          }
        }
      },
      required: ["repo_path", "agents"]
    },
    annotations: readOnlyAnnotations()
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const repoPath = requiredString(args, "repo_path");
      const agents = optionalStringList(args, "agents");

      if (agents.length === 0) {
        throw new Error("agents must include at least one provider:model assignment.");
      }

      const config = await loadConfig(repoPath);
      const health = await inspectRuntimeHealth(config);
      const purpose = optionalString(args, "purpose");
      const constraints = optionalStringList(args, "constraints");
      const contextKind = parseModelAccessContextKind(optionalString(args, "context_kind"));
      const repoVisibility = modelAccessRepoVisibility(
        await inspectRemoteRepoContext(repoPath, {
          provider: "chatgpt-web",
          model: "chatgpt-pro"
        })
      );
      const destinations = agents.map((agent) => modelAccessDestination(agent, health, contextKind, repoVisibility));
      const subject = destinations.map((destination) => destination.assignment).join(" + ");
      const purposeSuffix = purpose ? `: ${trimTerminalPunctuation(truncateText(purpose, 90))}` : "";
      const approvalCopy =
        contextKind === "no_repo_context"
          ? `I approve TheHood model access without repo context for ${subject}${purposeSuffix}.`
          : `I approve TheHood model access with ${modelAccessContextLabel(contextKind)} for ${subject}${purposeSuffix}.`;

      return {
        kind: "model_access_preflight",
        repo_path: repoPath,
        local_only: true,
        sends_repo_context: false,
        purpose: purpose ?? null,
        constraints,
        runtime_policy: {
          approval_mode: config.approvalPolicy.mode,
          external_transfers: config.approvalPolicy.externalTransfers.mode,
          max_auto_approve_bytes: config.approvalPolicy.externalTransfers.maxAutoApproveBytes,
          autopilot_allows_bounded_external_transfers:
            config.approvalPolicy.mode === "autopilot" ||
            config.approvalPolicy.externalTransfers.mode === "auto_low_risk"
        },
        data_boundary: modelAccessDisclosure(contextKind),
        repo_visibility: repoVisibility,
        destinations,
        approval_packet: {
          id: "thehood_model_access",
          copy: approvalCopy,
          copyable_text_block: copyableTextBlock(approvalCopy),
          display_hint:
            "When asking the user for this approval in Codex chat, render copyable_text_block as a fenced text block instead of inline prose.",
          summary:
            "Approve this packet once if the host requires explicit disclosure approval; otherwise use a no-repo-context or connector handoff path."
        },
        codex_host_policy_boundary: {
          status: "outside_thehood_runtime_control",
          summary:
            "TheHood autopilot can approve TheHood runtime gates, but it cannot override Codex or tenant host policy before an external model-backed call starts.",
          retry_guidance:
            "If Codex rejects the direct call, do not ask the user to type a fresh long disclosure phrase. Present this packet, use its compact approval copy, or switch to a no-repo-context or connector path."
        },
        recommended_paths: modelAccessRecommendedPaths(destinations, contextKind, repoVisibility)
      };
    })
});

const createProAccessTool = (): McpTool => ({
  definition: {
    name: "thehood_pro_access",
    title: "Inspect TheHood Pro Access Path",
    description: "Local-only preflight for ChatGPT Pro access. This does not call Pro, does not send repo context externally, and is the safe fallback when Codex host policy blocks a direct chatgpt-web consult.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo_path: {
          type: "string"
        },
        goal: {
          type: "string",
          description: "Optional user goal to include in the local-only handoff prompt."
        },
        constraints: {
          type: "array",
          items: {
            type: "string"
          }
        }
      },
      required: ["repo_path"]
    },
    annotations: readOnlyAnnotations()
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const repoPath = requiredString(args, "repo_path");
      const config = await loadConfig(repoPath);
      const health = await inspectRuntimeHealth(config);
      const chatGpt = health.providers.find((provider) => provider.id === "chatgpt-web");
      const goal = optionalString(args, "goal");
      const constraints = optionalStringList(args, "constraints");
      const bridgeIssues = chatGpt?.issues ?? ["provider_not_configured:chatgpt-web"];
      const bridgeReady = Boolean(chatGpt?.enabled && chatGpt.implemented && bridgeIssues.length === 0);
      const proAssignment = "chatgpt-web:chatgpt-pro";
      const connectorPrompt = [
        "Use TheHood as the local runtime and repo gateway.",
        "Do not rely on stale ChatGPT conversation context.",
        "Call TheHood MCP tools for repo/run evidence instead of asking Codex to paste private repo context.",
        "Return plans and strategic judgment as markdown in the role payload, with concrete next actions and evidence refs.",
        ...(goal ? [`Goal: ${goal}`] : []),
        ...(constraints.length > 0
          ? [
              "Constraints:",
              ...constraints.map((constraint) => `- ${constraint}`)
            ]
          : [])
      ].join("\n");

      return {
        kind: "pro_access_preflight",
        provider: proAssignment,
        repo_path: repoPath,
        runtime_policy: {
          approval_mode: config.approvalPolicy.mode,
          external_transfers: config.approvalPolicy.externalTransfers.mode,
          max_auto_approve_bytes: config.approvalPolicy.externalTransfers.maxAutoApproveBytes,
          autopilot_allows_bounded_external_transfers:
            config.approvalPolicy.mode === "autopilot" ||
            config.approvalPolicy.externalTransfers.mode === "auto_low_risk"
        },
        bridge: {
          status: bridgeReady ? "ready" : "not_ready",
          command: chatGpt?.command ?? null,
          issues: bridgeIssues
        },
        codex_host_policy_boundary: {
          status: "outside_thehood_runtime_control",
          summary:
            "TheHood autopilot can auto-approve TheHood runtime gates, but it cannot override a Codex or tenant policy that forbids disclosure to an external provider.",
          retry_guidance:
            "If Codex rejects a chatgpt-web consult as an external disclosure, do not ask for the same approval again. Use connector mode or an abstract no-repo-context prompt."
        },
        recommended_paths: [
          {
            id: "chatgpt_mcp_connector",
            status: "recommended_when_codex_blocks_external_disclosure",
            description:
              "Open ChatGPT Pro with TheHood as an MCP connector. ChatGPT requests bounded repo/run evidence through TheHood tools instead of Codex sending repo context to Pro.",
            setup_command: "node dist/cli/main.js mcp tunnel --tunnel-id <tunnel-id>",
            handoff_prompt: connectorPrompt
          },
          {
            id: "codex_agent_bridge",
            status: bridgeReady ? "runtime_ready_host_may_still_block" : "not_ready",
            description:
              "Codex asks TheHood to invoke the ChatGPT Web bridge. TheHood autopilot can handle runtime provider/transfer gates, but the MCP host may still block external disclosure before TheHood runs.",
            setup_command: "node dist/cli/main.js mcp config --chatgpt-web"
          },
          {
            id: "abstract_pro_prompt",
            status: "safe_when_no_repo_context_is_needed",
            description:
              "Ask Pro a product or architecture question without repo path, file excerpts, run artifacts, or private context."
          }
        ]
      };
    })
});

const createAgentBoardTool = (): McpTool => ({
  definition: {
    name: "thehood_agent_board",
    title: "Inspect TheHood Agent Board",
    description: "Return a visual-ready runtime-derived agent board for Codex app cards. The board is display guidance only and does not grant tools, schedule agents, satisfy gates, or approve work.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo_path: {
          type: "string"
        },
        run_id: {
          type: "string",
          description: "Optional run id. When present, cards include current lane state and evidence refs for that run."
        },
        include_artifact: {
          type: "boolean",
          description: "When true, include a renderable dashboard manifest and bounded snapshot for Codex app artifact rendering."
        }
      },
      required: ["repo_path"]
    },
    annotations: readOnlyAnnotations()
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const board = await agentBoardForRun(requiredString(args, "repo_path"), optionalString(args, "run_id"));
      const includeArtifact = optionalBoolean(args, "include_artifact") ?? false;

      return {
        ...toJsonObject(board),
        ...(includeArtifact ? { artifact: toJsonObject(buildAgentBoardArtifact(board)) } : {})
      };
    })
});

const createAssignRolesTool = (): McpTool => ({
  definition: {
    name: "thehood_assign_roles",
    title: "Assign TheHood Roles",
    description: "Persist provider:model assignments for one or more TheHood roles in the repo config, such as Claude as second judge, Sonnet as implementer, Spark as QA, or Pro as strategic orchestrator.",
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
      const health = await inspectRuntimeHealth(updated);

      return {
        roles: roleSummary(updated.roles),
        roster: toJsonObject(buildRoleRoster(updated, health)),
        health: toJsonObject(health)
      };
    })
});

const createConsultTool = (): McpTool => ({
  definition: {
    name: "thehood_consult",
    title: "Consult TheHood Guest Agent",
    description: "Create or advance a single read-only guest role, useful for asking Codex Spark, Pro, Claude, or another agent to plan, research, QA, second-judge, or critique from Codex chat. Model-backed providers may stop for invocation approval before the provider is called.",
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
          description: "provider:model assignment, for example codex-cli:spark, chatgpt-web:chatgpt-pro, chatgpt-web:configured, claude-code:sonnet, claude-code:fable, or stub:critic."
        },
        constraints: {
          type: "array",
          items: {
            type: "string"
          }
        },
        detail: detailProperty
      },
      required: ["goal", "repo_path", "role", "agent"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const detail = parseResponseDetail(args);
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
        ...runSummary(advanced.run, undefined, detail),
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
    description: "Summon a read-only role onto an existing run for planning, review, QA, research, second judgment, or critique. The runtime records the handoff and enforces provider invocation approval before model-backed calls.",
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
          description: "Optional one-call provider:model assignment, for example claude-code:sonnet, claude-code:mythos, codex-cli:spark, or stub:critic."
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
        },
        detail: detailProperty
      },
      required: ["run_id", "repo_path", "role", "brief"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const detail = parseResponseDetail(args);
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
        ...runSummary(result.run, undefined, detail),
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
        },
        detail: detailProperty
      },
      required: ["run_id", "repo_path", "items"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const detail = parseResponseDetail(args);
      const maxItems = optionalNumber(args, "max_items");
      const result = await fanoutAgents({
        repoPath: requiredString(args, "repo_path"),
        runId: requiredString(args, "run_id"),
        items: requiredObjectArray(args, "items").map(parseFanoutItem),
        ...(maxItems === undefined ? {} : { maxItems: Math.floor(maxItems) })
      });

      return {
        ...runSummary(result.run, undefined, detail),
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
    description: "Advance a run through the runtime. Use approval=none when no manual gate is active; runtime autopilot may auto-approve bounded provider invocation and non-secret external-transfer gates while recording approval evidence. Use approval=approve/reject/revise only for an active manual approval gate after user authorization.",
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
        },
        detail: detailProperty
      },
      required: ["run_id", "repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const detail = parseResponseDetail(args);
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
        ...runSummary(advanced.run, undefined, detail),
        advanced: advanced.advanced,
        stop_reason: advanced.stopReason,
        provider_response_count: advanced.providerResponses.length,
        provider_responses: agentResponsesSummary(advanced.providerResponses)
      };
    })
});

const createLoopTool = (): McpTool => ({
  definition: {
    name: "thehood_loop",
    title: "Run TheHood Autopilot Loop",
    description: "Keep advancing an existing TheHood run through the runtime loop until it reaches a terminal state, a required approval gate, no progress, or the max cycle cap. This does not approve manual gates; runtime autopilot policy may still auto-approve bounded gates.",
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
        max_cycles: {
          type: "number",
          description: "Optional positive integer. Defaults to 8."
        },
        max_steps_per_cycle: {
          type: "number",
          description: "Optional positive integer. Defaults to 10."
        },
        detail: detailProperty
      },
      required: ["run_id", "repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const detail = parseResponseDetail(args);
      const maxCycles = optionalPositiveInteger(args, "max_cycles");
      const maxStepsPerCycle = optionalPositiveInteger(args, "max_steps_per_cycle");
      const result = await runAutopilotLoop({
        repoPath: requiredString(args, "repo_path"),
        runId: requiredString(args, "run_id"),
        ...(maxCycles === undefined ? {} : { maxCycles }),
        ...(maxStepsPerCycle === undefined ? {} : { maxStepsPerCycle })
      });

      return {
        ...runLoopSummary(result, detail)
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
        },
        detail: detailProperty
      },
      required: ["run_id", "repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const detail = parseResponseDetail(args);
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
        ...runSummary(result.run, undefined, detail),
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
        },
        detail: detailProperty
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
        },
        detail: detailProperty
      },
      required: ["run_id", "repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const detail = parseResponseDetail(args);
      const repoPath = requiredString(args, "repo_path");
      const runId = requiredString(args, "run_id");
      const run = await getRun(repoPath, runId);
      const runInsights = await getRunInsights(run);
      const agentBoard = await agentBoardForRun(repoPath, runId, run, runInsights);

      return {
        ...runSummary(run, runInsights, detail),
        agent_board: detail === "full" ? toJsonObject(agentBoard) : compactAgentBoard(agentBoard),
        events: detail === "full"
          ? run.events.map((event) => ({
              created_at: event.createdAt,
              type: event.type,
              message: event.message
            }))
          : compactRunEvents(run)
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
        },
        detail: detailProperty
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
      const detail = parseResponseDetail(args);
      const runs = await listRuns(requiredString(args, "repo_path"));

      return {
        runs: runs.slice(0, Math.min(limit, 100)).map((run) => runSummary(run, undefined, detail))
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
      const detail = parseResponseDetail(args);
      const result = await captureGitEvidence(
        requiredString(args, "repo_path"),
        requiredString(args, "run_id")
      );

      return {
        ...runSummary(result.run, undefined, detail),
        changed_paths: result.changedPaths,
        protected_changes: result.protectedChanges.map((match) => ({
          path: match.path,
          pattern: match.pattern
        })),
        artifacts: detail === "full"
          ? result.run.artifacts.map((artifact) => ({
              kind: artifact.kind,
              ref: artifact.ref,
              summary: artifact.summary
            }))
          : latestItems(result.run.artifacts, compactArtifactLimit).items.map(artifactSummary)
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
        },
        detail: detailProperty
      },
      required: ["run_id", "repo_path"]
    }
  },
  handle: async (argumentsValue) =>
    executeTool(argumentsValue, async (args) => {
      const detail = parseResponseDetail(args);
      const run = await abortRun(
        requiredString(args, "repo_path"),
        requiredString(args, "run_id"),
        optionalString(args, "reason") ?? "Aborted through MCP."
      );

      return runSummary(run, undefined, detail);
    })
});

export const mcpTools: McpTool[] = [
  createDoctorTool(),
  createRolesTool(),
  createModelAccessTool(),
  createProAccessTool(),
  createAgentBoardTool(),
  createAssignRolesTool(),
  createPlanTool(),
  createOrchestrateTool(),
  createConsultTool(),
  createSummonTool(),
  createFanoutTool(),
  createContinueTool(),
  createLoopTool(),
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
