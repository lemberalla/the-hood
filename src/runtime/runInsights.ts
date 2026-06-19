import { readRunArtifact } from "./artifacts.js";
import { recentAutopilotApprovalsFromRuns } from "./approvalInbox.js";
import { buildCanonicalMemory, latestCanonicalArtifactRefs } from "./canonicalMemory.js";
import { deriveLoopResponsibilitySchedule } from "./loopResponsibilities.js";
import { deriveOperatorNextActions } from "./operatorNextActions.js";
import { deriveReviewLanes } from "./reviewLanes.js";
import { agentMarkdownField, boundAgentMarkdownPayloads, extractAgentMarkdown } from "../providers/markdownPayload.js";
import {
  latestRunHandoff,
  recentRunHandoffSummaries,
  summarizeRunHandoff,
  type RunHandoffSummary
} from "./handoffs.js";
import type { AgentResponse } from "../providers/types.js";
import type { AutopilotApproval } from "./approvalInbox.js";
import type {
  JsonObject,
  LoopResponsibilitySchedule,
  OperatorNextAction,
  ReviewLane,
  RunArtifact,
  RunRecord
} from "./types.js";

export interface RunArtifactSummary {
  kind: RunArtifact["kind"];
  ref: string;
  summary: string;
}

export interface LatestAgentResponseInsight {
  artifact: RunArtifactSummary;
  status: AgentResponse["status"];
  summary: string;
  data: JsonObject;
  primaryOutputKey?: string;
  primaryOutput?: JsonObject;
  markdown?: LatestAgentResponseMarkdownInsight;
  decision?: JsonObject;
}

export interface LatestAgentResponseMarkdownInsight {
  field: typeof agentMarkdownField;
  preview: string;
  truncated: boolean;
  charLength: number;
}

export interface FinalReportInsight {
  artifact: RunArtifactSummary;
  completedBy?: JsonObject;
  stopReason?: string;
}

export interface CriticTriggerInsight {
  artifact: RunArtifactSummary;
  reasonCode?: string;
  reason?: string;
  sourceRoles: string[];
  evidenceRefs: string[];
  criticResponseRef?: string;
}

export interface RevisionPacketInsight {
  artifact: RunArtifactSummary;
  sourceRole?: string;
  reasonCode?: string;
  reason?: string;
  repairObjective?: string;
  acceptanceCriteria: string[];
  evidenceRefs: string[];
  sourceResponseRef?: string;
  criticTriggerRef?: string;
}

export interface ReviewRoutingInsight {
  artifact: RunArtifactSummary;
  riskTier?: string;
  action?: string;
  required?: JsonObject;
  reasons: string[];
  signals?: JsonObject;
}

export interface ProviderExecutionInsight {
  artifact: RunArtifactSummary;
  role?: string;
  provider?: string;
  model?: string;
  command?: string;
  args: string[];
  commandMode?: string;
  workspaceMode?: string;
  sandbox?: string;
  permissionMode?: string;
  exitCode?: number;
  timedOut?: boolean;
  durationMs?: number;
  responseParsed?: boolean;
  responseStatus?: string;
}

export interface FanoutInsight {
  artifact: RunArtifactSummary;
  status?: string;
  requestedItems?: number;
  executedItems?: number;
  maxItems?: number;
  sidecarOnly: boolean;
  canSatisfyRequiredGates: boolean;
  items: FanoutItemInsight[];
}

export interface FanoutItemInsight {
  index: number;
  role?: string;
  summonKind?: string;
  status?: string;
  responseArtifactRef?: string;
  directiveArtifactRef?: string;
}

export interface RunInsights {
  latestAgentResponse?: LatestAgentResponseInsight;
  finalReport?: FinalReportInsight;
  latestCriticTrigger?: CriticTriggerInsight;
  latestRevisionPacket?: RevisionPacketInsight;
  latestReviewRouting?: ReviewRoutingInsight;
  latestProviderExecution?: ProviderExecutionInsight;
  recentProviderExecutions: ProviderExecutionInsight[];
  latestFanout?: FanoutInsight;
  latestProgressPacket?: RunArtifactSummary;
  latestReconciliation?: RunArtifactSummary;
  latestRepoContext?: RunArtifactSummary;
  latestRemoteRepoContext?: RunArtifactSummary;
  latestTransferManifest?: RunArtifactSummary;
  canonicalMemory?: JsonObject;
  loopResponsibilities: LoopResponsibilitySchedule;
  reviewLanes: ReviewLane[];
  operatorNextActions: OperatorNextAction[];
  latestHandoff?: RunHandoffSummary;
  handoffTimeline: RunHandoffSummary[];
  recentAutopilotApprovals: AutopilotApproval[];
  issues: string[];
}

const agentResponseKinds = new Set<RunArtifact["kind"]>(["plan", "agent", "reconciliation"]);
const primaryOutputKeys = [
  "decision",
  "verificationResult",
  "implementationResult",
  "qaResult",
  "critiqueResult",
  "researchResult"
];
const markdownPreviewChars = 2_000;

const summarizeArtifact = (artifact: RunArtifact): RunArtifactSummary => ({
  kind: artifact.kind,
  ref: artifact.ref,
  summary: artifact.summary
});

const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const markdownInsight = (markdown: string | undefined): LatestAgentResponseMarkdownInsight | undefined => {
  if (!markdown) {
    return undefined;
  }

  return {
    field: agentMarkdownField,
    preview: markdown.slice(0, markdownPreviewChars),
    truncated: markdown.length > markdownPreviewChars,
    charLength: markdown.length
  };
};

const readArtifactJson = async (
  run: RunRecord,
  artifact: RunArtifact,
  issues: string[]
): Promise<JsonObject | undefined> => {
  try {
    const result = await readRunArtifact({
      repoPath: run.repoPath,
      runId: run.runId,
      ref: artifact.ref,
      maxBytes: 200_000
    });

    if (result.truncated) {
      issues.push(`Artifact ${artifact.ref} was truncated while building run status insights.`);
      return undefined;
    }

    const parsed = JSON.parse(result.content) as unknown;
    if (!isJsonObject(parsed)) {
      issues.push(`Artifact ${artifact.ref} did not contain a JSON object.`);
      return undefined;
    }

    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(`Could not read artifact ${artifact.ref}: ${message}`);
    return undefined;
  }
};

const parseAgentResponse = (
  artifact: RunArtifact,
  payload: JsonObject,
  issues: string[]
): LatestAgentResponseInsight | undefined => {
  const status = payload.status;
  const summary = payload.summary;
  const rawData = payload.data;

  if (
    (status !== "ok" && status !== "blocked" && status !== "failed") ||
    typeof summary !== "string" ||
    !isJsonObject(rawData)
  ) {
    issues.push(`Artifact ${artifact.ref} is not a valid AgentResponse envelope.`);
    return undefined;
  }

  const primaryOutputKey = primaryOutputKeys.find((key) => isJsonObject(rawData[key]));
  const rawPrimaryOutput = primaryOutputKey ? rawData[primaryOutputKey] as JsonObject : undefined;
  const markdown = markdownInsight(extractAgentMarkdown(rawPrimaryOutput));
  const data = boundAgentMarkdownPayloads(rawData, markdownPreviewChars);
  const primaryOutput = primaryOutputKey ? data[primaryOutputKey] as JsonObject : undefined;
  const decision = isJsonObject(data.decision) ? data.decision : undefined;

  return {
    artifact: summarizeArtifact(artifact),
    status,
    summary,
    data,
    ...(primaryOutputKey ? { primaryOutputKey } : {}),
    ...(primaryOutput ? { primaryOutput } : {}),
    ...(markdown ? { markdown } : {}),
    ...(decision ? { decision } : {})
  };
};

const latestAgentArtifact = (run: RunRecord): RunArtifact | undefined =>
  run.artifacts.filter((artifact) => agentResponseKinds.has(artifact.kind)).at(-1);

const finalReportArtifact = (run: RunRecord): RunArtifact | undefined => {
  const event = run.events.filter((candidate) => candidate.type === "final_report_written").at(-1);
  const eventArtifactRef = event?.data?.artifactRef;

  if (typeof eventArtifactRef === "string") {
    const artifact = run.artifacts.find((candidate) => candidate.ref === eventArtifactRef);
    if (artifact) {
      return artifact;
    }
  }

  return run.artifacts
    .filter((artifact) => artifact.kind === "report" && artifact.summary.includes("Final report"))
    .at(-1);
};

const criticTriggerArtifact = (run: RunRecord): RunArtifact | undefined =>
  run.artifacts.filter((artifact) => artifact.kind === "critic_trigger").at(-1);

const revisionPacketArtifact = (run: RunRecord): RunArtifact | undefined =>
  run.artifacts.filter((artifact) => artifact.kind === "revision_packet").at(-1);

const reviewRoutingArtifact = (run: RunRecord): RunArtifact | undefined =>
  run.artifacts.filter((artifact) => artifact.kind === "review_routing").at(-1);

const providerExecutionArtifacts = (run: RunRecord): RunArtifact[] =>
  run.artifacts.filter((artifact) => artifact.kind === "provider_invocation");

const fanoutArtifact = (run: RunRecord): RunArtifact | undefined =>
  run.artifacts.filter((artifact) => artifact.kind === "fanout").at(-1);

const parseFinalReport = (
  artifact: RunArtifact,
  payload: JsonObject
): FinalReportInsight => ({
  artifact: summarizeArtifact(artifact),
  ...(isJsonObject(payload.completedBy) ? { completedBy: payload.completedBy } : {}),
  ...(typeof payload.stopReason === "string" ? { stopReason: payload.stopReason } : {})
});

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const parseCriticTrigger = (
  artifact: RunArtifact,
  payload: JsonObject
): CriticTriggerInsight => ({
  artifact: summarizeArtifact(artifact),
  ...(typeof payload.reasonCode === "string" ? { reasonCode: payload.reasonCode } : {}),
  ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
  sourceRoles: stringArray(payload.sourceRoles),
  evidenceRefs: stringArray(payload.evidenceRefs),
  ...(typeof payload.criticResponseRef === "string" ? { criticResponseRef: payload.criticResponseRef } : {})
});

const parseRevisionPacket = (
  artifact: RunArtifact,
  payload: JsonObject
): RevisionPacketInsight => ({
  artifact: summarizeArtifact(artifact),
  ...(typeof payload.sourceRole === "string" ? { sourceRole: payload.sourceRole } : {}),
  ...(typeof payload.reasonCode === "string" ? { reasonCode: payload.reasonCode } : {}),
  ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
  ...(typeof payload.repairObjective === "string" ? { repairObjective: payload.repairObjective } : {}),
  acceptanceCriteria: stringArray(payload.acceptanceCriteria),
  evidenceRefs: stringArray(payload.evidenceRefs),
  ...(typeof payload.sourceResponseRef === "string" ? { sourceResponseRef: payload.sourceResponseRef } : {}),
  ...(typeof payload.criticTriggerRef === "string" ? { criticTriggerRef: payload.criticTriggerRef } : {})
});

const parseReviewRouting = (
  artifact: RunArtifact,
  payload: JsonObject
): ReviewRoutingInsight => ({
  artifact: summarizeArtifact(artifact),
  ...(typeof payload.riskTier === "string" ? { riskTier: payload.riskTier } : {}),
  ...(typeof payload.action === "string" ? { action: payload.action } : {}),
  ...(isJsonObject(payload.required) ? { required: payload.required } : {}),
  reasons: stringArray(payload.reasons),
  ...(isJsonObject(payload.signals) ? { signals: payload.signals } : {})
});

const parseProviderExecution = (
  artifact: RunArtifact,
  payload: JsonObject
): ProviderExecutionInsight => {
  const exitCode = numberField(payload.exitCode);
  const durationMs = numberField(payload.durationMs);

  return {
    artifact: summarizeArtifact(artifact),
    ...(typeof payload.role === "string" ? { role: payload.role } : {}),
    ...(typeof payload.provider === "string" ? { provider: payload.provider } : {}),
    ...(typeof payload.model === "string" ? { model: payload.model } : {}),
    ...(typeof payload.command === "string" ? { command: payload.command } : {}),
    args: stringArray(payload.args),
    ...(typeof payload.commandMode === "string" ? { commandMode: payload.commandMode } : {}),
    ...(typeof payload.workspaceMode === "string" ? { workspaceMode: payload.workspaceMode } : {}),
    ...(typeof payload.sandbox === "string" ? { sandbox: payload.sandbox } : {}),
    ...(typeof payload.permissionMode === "string" ? { permissionMode: payload.permissionMode } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(typeof payload.timedOut === "boolean" ? { timedOut: payload.timedOut } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(typeof payload.responseParsed === "boolean" ? { responseParsed: payload.responseParsed } : {}),
    ...(typeof payload.responseStatus === "string" ? { responseStatus: payload.responseStatus } : {})
  };
};

const numberField = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const artifactRefField = (value: unknown): string | undefined =>
  isJsonObject(value) && typeof value.ref === "string" ? value.ref : undefined;

const parseFanoutItem = (value: unknown): FanoutItemInsight | undefined => {
  if (!isJsonObject(value)) {
    return undefined;
  }

  const index = numberField(value.index);
  if (index === undefined) {
    return undefined;
  }
  const responseArtifactRef = artifactRefField(value.responseArtifact);
  const directiveArtifactRef = artifactRefField(value.directiveArtifact);

  return {
    index,
    ...(typeof value.role === "string" ? { role: value.role } : {}),
    ...(typeof value.summonKind === "string" ? { summonKind: value.summonKind } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(responseArtifactRef ? { responseArtifactRef } : {}),
    ...(directiveArtifactRef ? { directiveArtifactRef } : {})
  };
};

const parseFanout = (
  artifact: RunArtifact,
  payload: JsonObject
): FanoutInsight => {
  const bounds = isJsonObject(payload.bounds) ? payload.bounds : {};
  const safety = isJsonObject(payload.safety) ? payload.safety : {};
  const items = Array.isArray(payload.items)
    ? payload.items.map(parseFanoutItem).filter((item): item is FanoutItemInsight => Boolean(item))
    : [];
  const requestedItems = numberField(bounds.requestedItems);
  const executedItems = numberField(bounds.executedItems);
  const maxItems = numberField(bounds.maxItems);

  return {
    artifact: summarizeArtifact(artifact),
    ...(typeof payload.status === "string" ? { status: payload.status } : {}),
    ...(requestedItems !== undefined ? { requestedItems } : {}),
    ...(executedItems !== undefined ? { executedItems } : {}),
    ...(maxItems !== undefined ? { maxItems } : {}),
    sidecarOnly: safety.sidecarOnly === true,
    canSatisfyRequiredGates: safety.canSatisfyRequiredGates === true,
    items
  };
};

export const getRunInsights = async (run: RunRecord): Promise<RunInsights> => {
  const issues: string[] = [];
  const latestRefs = latestCanonicalArtifactRefs(run);
  const latestAgent = latestAgentArtifact(run);
  const latestAgentPayload = latestAgent
    ? await readArtifactJson(run, latestAgent, issues)
    : undefined;
  const finalReport = finalReportArtifact(run);
  const finalReportPayload = finalReport
    ? await readArtifactJson(run, finalReport, issues)
    : undefined;
  const criticTrigger = criticTriggerArtifact(run);
  const criticTriggerPayload = criticTrigger
    ? await readArtifactJson(run, criticTrigger, issues)
    : undefined;
  const revisionPacket = revisionPacketArtifact(run);
  const revisionPacketPayload = revisionPacket
    ? await readArtifactJson(run, revisionPacket, issues)
    : undefined;
  const reviewRouting = reviewRoutingArtifact(run);
  const reviewRoutingPayload = reviewRouting
    ? await readArtifactJson(run, reviewRouting, issues)
    : undefined;
  const providerExecutionArtifactsForRun = providerExecutionArtifacts(run).slice(-5);
  const providerExecutionPayloads = await Promise.all(
    providerExecutionArtifactsForRun.map((artifact) => readArtifactJson(run, artifact, issues))
  );
  const latestFanout = fanoutArtifact(run);
  const latestFanoutPayload = latestFanout
    ? await readArtifactJson(run, latestFanout, issues)
    : undefined;
  const latestAgentResponse = latestAgent && latestAgentPayload
    ? parseAgentResponse(latestAgent, latestAgentPayload, issues)
    : undefined;
  const canonicalMemory = await buildCanonicalMemory(run).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(`Could not build canonical memory: ${message}`);
    return undefined;
  });

  const latestHandoff = latestRunHandoff(run);
  const insights: RunInsights = {
    ...(latestHandoff ? { latestHandoff: summarizeRunHandoff(latestHandoff) } : {}),
    loopResponsibilities: deriveLoopResponsibilitySchedule(run),
    reviewLanes: deriveReviewLanes(run),
    operatorNextActions: deriveOperatorNextActions(run),
    handoffTimeline: recentRunHandoffSummaries(run, 5),
    recentAutopilotApprovals: recentAutopilotApprovalsFromRuns([run]),
    recentProviderExecutions: providerExecutionArtifactsForRun
      .map((artifact, index) => {
        const payload = providerExecutionPayloads[index];
        return payload ? parseProviderExecution(artifact, payload) : undefined;
      })
      .filter((execution): execution is ProviderExecutionInsight => Boolean(execution)),
    issues
  };

  if (insights.recentProviderExecutions.length > 0) {
    const latestProviderExecution = insights.recentProviderExecutions.at(-1);
    if (latestProviderExecution) {
      insights.latestProviderExecution = latestProviderExecution;
    }
  }

  if (latestRefs.latestProgressPacket) {
    insights.latestProgressPacket = latestRefs.latestProgressPacket;
  }

  if (latestRefs.latestReconciliation) {
    insights.latestReconciliation = latestRefs.latestReconciliation;
  }

  if (latestRefs.latestRepoContext) {
    insights.latestRepoContext = latestRefs.latestRepoContext;
  }

  if (latestRefs.latestRemoteRepoContext) {
    insights.latestRemoteRepoContext = latestRefs.latestRemoteRepoContext;
  }

  if (latestRefs.latestTransferManifest) {
    insights.latestTransferManifest = latestRefs.latestTransferManifest;
  }

  if (canonicalMemory) {
    insights.canonicalMemory = canonicalMemory;
  }

  if (latestAgentResponse) {
    insights.latestAgentResponse = latestAgentResponse;
  }

  if (finalReport && finalReportPayload) {
    insights.finalReport = parseFinalReport(finalReport, finalReportPayload);
  }

  if (criticTrigger && criticTriggerPayload) {
    insights.latestCriticTrigger = parseCriticTrigger(criticTrigger, criticTriggerPayload);
  }

  if (revisionPacket && revisionPacketPayload) {
    insights.latestRevisionPacket = parseRevisionPacket(revisionPacket, revisionPacketPayload);
  }

  if (reviewRouting && reviewRoutingPayload) {
    insights.latestReviewRouting = parseReviewRouting(reviewRouting, reviewRoutingPayload);
  }

  if (latestFanout && latestFanoutPayload) {
    insights.latestFanout = parseFanout(latestFanout, latestFanoutPayload);
  }

  return insights;
};
