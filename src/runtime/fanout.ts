import { writeRunArtifact } from "./artifacts.js";
import { loadConfig } from "./config.js";
import { InputError } from "./errors.js";
import { newId, nowIso } from "./ids.js";
import { defaultRolePermissions } from "./permissions.js";
import { loadRun, saveRun } from "./store.js";
import { summonAgent } from "./summons.js";
import type { AgentResponse } from "../providers/types.js";
import type {
  JsonObject,
  RoleAssignment,
  RunArtifact,
  RunEvent,
  RunRecord,
  RuntimeRole
} from "./types.js";

export type FanoutStatus = "completed" | "blocked" | "failed";
export type FanoutItemStatus = "completed" | "blocked" | "failed";

export interface FanoutItemInput {
  role: RuntimeRole;
  brief: string;
  summonKind?: string;
  persona?: string;
  agent?: RoleAssignment;
  constraints?: string[];
  evidenceRefs?: string[];
}

export interface FanoutAgentsInput {
  repoPath: string;
  runId: string;
  items: FanoutItemInput[];
  maxItems?: number;
}

export interface FanoutBounds {
  requestedItems: number;
  maxItems: number;
  hardMaxItems: number;
  executedItems: number;
  execution: "sequential";
}

export interface FanoutItemResult {
  index: number;
  role: RuntimeRole;
  summonKind: string;
  brief: string;
  status: FanoutItemStatus;
  stopReason: string;
  providerResponseCount: number;
  assignment?: RoleAssignment;
  providerStatus?: AgentResponse["status"];
  directiveArtifact?: RunArtifact;
  responseArtifact?: RunArtifact;
  error?: string;
}

export interface FanoutAgentsResult {
  run: RunRecord;
  status: FanoutStatus;
  bounds: FanoutBounds;
  items: FanoutItemResult[];
  artifact: RunArtifact;
}

export interface FanoutArtifactPayload {
  schemaVersion: 1;
  kind: "fanout";
  runId: string;
  createdAt: string;
  status: FanoutStatus;
  bounds: FanoutBounds;
  safety: {
    sidecarOnly: boolean;
    readOnlyRolesOnly: boolean;
    canSatisfyRequiredGates: boolean;
    instruction: string;
  };
  items: JsonObject[];
}

const fanoutRoles: RuntimeRole[] = [
  "orchestrator",
  "planner",
  "researcher",
  "qa",
  "verifier",
  "critic"
];

export const defaultFanoutMaxItems = 8;
const hardFanoutMaxItems = 8;
const maxTextLength = 500;

const createEvent = (type: string, message: string, data?: JsonObject): RunEvent => ({
  id: newId("event"),
  createdAt: nowIso(),
  type,
  message,
  ...(data ? { data } : {})
});

const truncateText = (value: string): string =>
  value.length <= maxTextLength ? value : `${value.slice(0, maxTextLength - 3)}...`;

const isFanoutRole = (role: RuntimeRole): boolean =>
  fanoutRoles.includes(role) && !defaultRolePermissions[role].edit;

const normalizeItems = (items: FanoutItemInput[], maxItems: number): FanoutItemInput[] => {
  if (items.length === 0) {
    throw new InputError("Fan-out requires at least one item.");
  }

  if (items.length > maxItems) {
    throw new InputError(`Fan-out accepts at most ${maxItems} item(s) for this call.`);
  }

  return items.map((item, index) => {
    if (!isFanoutRole(item.role)) {
      throw new InputError(
        `Fan-out item ${index + 1} role must be orchestrator, planner, researcher, qa, verifier, or critic.`
      );
    }

    const brief = item.brief.trim();
    if (!brief) {
      throw new InputError(`Fan-out item ${index + 1} brief cannot be empty.`);
    }

    return {
      role: item.role,
      brief,
      ...(item.summonKind ? { summonKind: item.summonKind } : {}),
      ...(item.persona ? { persona: item.persona } : {}),
      ...(item.agent ? { agent: item.agent } : {}),
      constraints: item.constraints ?? [],
      evidenceRefs: item.evidenceRefs ?? []
    };
  });
};

const resolveConfiguredMaxItems = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InputError("Configured defaults.fanoutMaxItems must be a positive integer.");
  }

  if (value > hardFanoutMaxItems) {
    throw new InputError(`Configured defaults.fanoutMaxItems cannot exceed ${hardFanoutMaxItems}.`);
  }

  return value;
};

const resolveMaxItems = (value: number | undefined, configuredMaxItems: number): number => {
  const policyMaxItems = resolveConfiguredMaxItems(configuredMaxItems);

  if (value === undefined) {
    return policyMaxItems;
  }

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InputError("Fan-out maxItems must be a positive integer.");
  }

  if (value > policyMaxItems) {
    throw new InputError(`Fan-out maxItems cannot exceed configured defaults.fanoutMaxItems (${policyMaxItems}).`);
  }

  if (value > hardFanoutMaxItems) {
    throw new InputError(`Fan-out maxItems cannot exceed ${hardFanoutMaxItems}.`);
  }

  return value;
};

const itemStatusFromResponse = (
  run: RunRecord,
  response: AgentResponse | undefined
): FanoutItemStatus => {
  if (run.approvalRequired || response?.status === "blocked") {
    return "blocked";
  }

  if (response?.status === "failed") {
    return "failed";
  }

  return "completed";
};

const resultFromSummon = (
  index: number,
  brief: string,
  result: Awaited<ReturnType<typeof summonAgent>>
): FanoutItemResult => {
  const latestResponse = result.providerResponses.at(-1);
  const status = itemStatusFromResponse(result.run, latestResponse);

  return {
    index,
    role: result.role,
    summonKind: result.summonKind,
    brief: truncateText(brief),
    status,
    stopReason: result.stopReason,
    providerResponseCount: result.providerResponses.length,
    assignment: result.assignment,
    ...(latestResponse ? { providerStatus: latestResponse.status } : {}),
    ...(result.directiveArtifact ? { directiveArtifact: result.directiveArtifact } : {}),
    ...(result.responseArtifact ? { responseArtifact: result.responseArtifact } : {})
  };
};

const failedItem = (
  index: number,
  item: FanoutItemInput,
  error: unknown
): FanoutItemResult => {
  const message = error instanceof Error ? error.message : String(error);

  return {
    index,
    role: item.role,
    summonKind: item.summonKind ?? (item.role === "qa" ? "qa" : "review"),
    brief: truncateText(item.brief),
    status: "failed",
    stopReason: message,
    providerResponseCount: 0,
    ...(item.agent ? { assignment: item.agent } : {}),
    error: message
  };
};

const fanoutStatus = (items: FanoutItemResult[]): FanoutStatus => {
  if (items.some((item) => item.status === "blocked")) {
    return "blocked";
  }

  if (items.some((item) => item.status === "failed")) {
    return "failed";
  }

  return "completed";
};

const artifactSummary = (artifact: RunArtifact | undefined): JsonObject | undefined =>
  artifact
    ? {
        kind: artifact.kind,
        ref: artifact.ref,
        summary: artifact.summary
      }
    : undefined;

const assignmentSummary = (assignment: RoleAssignment | undefined): JsonObject | undefined =>
  assignment
    ? {
        provider: assignment.provider,
        model: assignment.model
      }
    : undefined;

const itemPayload = (item: FanoutItemResult): JsonObject => {
  const assignment = assignmentSummary(item.assignment);
  const directiveArtifact = artifactSummary(item.directiveArtifact);
  const responseArtifact = artifactSummary(item.responseArtifact);

  return {
    index: item.index,
    role: item.role,
    summonKind: item.summonKind,
    status: item.status,
    brief: item.brief,
    stopReason: item.stopReason,
    providerResponseCount: item.providerResponseCount,
    ...(item.providerStatus ? { providerStatus: item.providerStatus } : {}),
    ...(assignment ? { assignment } : {}),
    ...(directiveArtifact ? { directiveArtifact } : {}),
    ...(responseArtifact ? { responseArtifact } : {}),
    ...(item.error ? { error: item.error } : {})
  };
};

const buildFanoutPayload = (
  run: RunRecord,
  status: FanoutStatus,
  bounds: FanoutBounds,
  items: FanoutItemResult[]
): FanoutArtifactPayload => ({
  schemaVersion: 1,
  kind: "fanout",
  runId: run.runId,
  createdAt: nowIso(),
  status,
  bounds,
  safety: {
    sidecarOnly: true,
    readOnlyRolesOnly: true,
    canSatisfyRequiredGates: false,
    instruction: "Fan-out evidence is advisory. It cannot satisfy verifier, runtime QA, approval, or completion gates."
  },
  items: items.map(itemPayload)
});

const appendFanoutArtifact = async (
  run: RunRecord,
  status: FanoutStatus,
  bounds: FanoutBounds,
  items: FanoutItemResult[]
): Promise<{ run: RunRecord; artifact: RunArtifact }> => {
  const latest = await loadRun(run.repoPath, run.runId);
  const payload = buildFanoutPayload(latest, status, bounds, items);
  const artifact = await writeRunArtifact({
    repoPath: latest.repoPath,
    runId: latest.runId,
    kind: "fanout",
    name: `fanout-${newId("fanout")}.json`,
    content: `${JSON.stringify(payload, null, 2)}\n`,
    summary: `Agent fan-out ${status}: ${bounds.executedItems}/${bounds.requestedItems} item(s)`
  });
  const updated: RunRecord = {
    ...latest,
    updatedAt: nowIso(),
    artifacts: [...latest.artifacts, artifact],
    events: [
      ...latest.events,
      createEvent("agent_fanout_completed", artifact.summary, {
        status,
        artifactRef: artifact.ref,
        requestedItems: bounds.requestedItems,
        executedItems: bounds.executedItems,
        maxItems: bounds.maxItems
      })
    ]
  };

  await saveRun(updated);

  return {
    run: updated,
    artifact
  };
};

export const fanoutAgents = async (input: FanoutAgentsInput): Promise<FanoutAgentsResult> => {
  const config = await loadConfig(input.repoPath);
  const maxItems = resolveMaxItems(input.maxItems, config.defaults.fanoutMaxItems);
  const items = normalizeItems(input.items, maxItems);
  const initialRun = await loadRun(input.repoPath, input.runId);

  if (initialRun.approvalRequired) {
    throw new InputError(
      `Run ${initialRun.runId} is waiting for approval: ${initialRun.approvalReason ?? "approval required"}.`
    );
  }

  let currentRun = initialRun;
  const results: FanoutItemResult[] = [];

  for (const [index, item] of items.entries()) {
    try {
      const result = await summonAgent({
        repoPath: input.repoPath,
        runId: input.runId,
        role: item.role,
        brief: item.brief,
        ...(item.summonKind ? { summonKind: item.summonKind } : {}),
        ...(item.persona ? { persona: item.persona } : {}),
        ...(item.agent ? { agent: item.agent } : {}),
        constraints: item.constraints ?? [],
        evidenceRefs: item.evidenceRefs ?? []
      });
      const itemResult = resultFromSummon(index, item.brief, result);
      results.push(itemResult);
      currentRun = result.run;

      if (itemResult.status !== "completed") {
        break;
      }
    } catch (error) {
      const itemResult = failedItem(index, item, error);
      results.push(itemResult);
      currentRun = await loadRun(input.repoPath, input.runId);
      break;
    }
  }

  const status = fanoutStatus(results);
  const bounds: FanoutBounds = {
    requestedItems: items.length,
    maxItems,
    hardMaxItems: hardFanoutMaxItems,
    executedItems: results.length,
    execution: "sequential"
  };
  const appended = await appendFanoutArtifact(currentRun, status, bounds, results);

  return {
    run: appended.run,
    status,
    bounds,
    items: results,
    artifact: appended.artifact
  };
};
