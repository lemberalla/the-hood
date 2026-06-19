import { readRunArtifact } from "./artifacts.js";
import { recentAutopilotApprovalsFromRuns } from "./approvalInbox.js";
import type { AgentResponse } from "../providers/types.js";
import type { AutopilotApproval } from "./approvalInbox.js";
import type { JsonObject, RunArtifact, RunRecord } from "./types.js";

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
  decision?: JsonObject;
}

export interface FinalReportInsight {
  artifact: RunArtifactSummary;
  completedBy?: JsonObject;
  stopReason?: string;
}

export interface RunInsights {
  latestAgentResponse?: LatestAgentResponseInsight;
  finalReport?: FinalReportInsight;
  recentAutopilotApprovals: AutopilotApproval[];
  issues: string[];
}

const agentResponseKinds = new Set<RunArtifact["kind"]>(["plan", "agent", "reconciliation"]);
const primaryOutputKeys = [
  "decision",
  "verificationResult",
  "implementationResult",
  "critiqueResult",
  "researchResult"
];

const summarizeArtifact = (artifact: RunArtifact): RunArtifactSummary => ({
  kind: artifact.kind,
  ref: artifact.ref,
  summary: artifact.summary
});

const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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
  const data = payload.data;

  if (
    (status !== "ok" && status !== "blocked" && status !== "failed") ||
    typeof summary !== "string" ||
    !isJsonObject(data)
  ) {
    issues.push(`Artifact ${artifact.ref} is not a valid AgentResponse envelope.`);
    return undefined;
  }

  const primaryOutputKey = primaryOutputKeys.find((key) => isJsonObject(data[key]));
  const primaryOutput = primaryOutputKey ? data[primaryOutputKey] as JsonObject : undefined;
  const decision = isJsonObject(data.decision) ? data.decision : undefined;

  return {
    artifact: summarizeArtifact(artifact),
    status,
    summary,
    data,
    ...(primaryOutputKey ? { primaryOutputKey } : {}),
    ...(primaryOutput ? { primaryOutput } : {}),
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

const parseFinalReport = (
  artifact: RunArtifact,
  payload: JsonObject
): FinalReportInsight => ({
  artifact: summarizeArtifact(artifact),
  ...(isJsonObject(payload.completedBy) ? { completedBy: payload.completedBy } : {}),
  ...(typeof payload.stopReason === "string" ? { stopReason: payload.stopReason } : {})
});

export const getRunInsights = async (run: RunRecord): Promise<RunInsights> => {
  const issues: string[] = [];
  const latestAgent = latestAgentArtifact(run);
  const latestAgentPayload = latestAgent
    ? await readArtifactJson(run, latestAgent, issues)
    : undefined;
  const finalReport = finalReportArtifact(run);
  const finalReportPayload = finalReport
    ? await readArtifactJson(run, finalReport, issues)
    : undefined;
  const latestAgentResponse = latestAgent && latestAgentPayload
    ? parseAgentResponse(latestAgent, latestAgentPayload, issues)
    : undefined;

  const insights: RunInsights = {
    recentAutopilotApprovals: recentAutopilotApprovalsFromRuns([run]),
    issues
  };

  if (latestAgentResponse) {
    insights.latestAgentResponse = latestAgentResponse;
  }

  if (finalReport && finalReportPayload) {
    insights.finalReport = parseFinalReport(finalReport, finalReportPayload);
  }

  return insights;
};
