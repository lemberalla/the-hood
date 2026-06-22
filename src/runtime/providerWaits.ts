import crypto from "node:crypto";
import { writeRunArtifact } from "./artifacts.js";
import { newId, nowIso } from "./ids.js";
import { loadRun, saveRun } from "./store.js";
import type { AgentDirective } from "../providers/types.js";
import type {
  JsonObject,
  ProviderWaitRecord,
  ProviderWaitStatus,
  ProviderWaitTarget,
  RoleAssignment,
  RunArtifact,
  RunEvent,
  RunRecord,
  RuntimeRole
} from "./types.js";

export interface BeginProviderWaitInput {
  run: RunRecord;
  role: RuntimeRole;
  assignment: RoleAssignment;
  directive: AgentDirective;
  directiveArtifact: RunArtifact;
}

export interface MarkProviderWaitPostedInput {
  run: RunRecord;
  role: RuntimeRole;
  assignment: RoleAssignment;
  directive: AgentDirective;
  target?: ProviderWaitTarget;
}

export interface CompleteProviderWaitInput {
  status: ProviderWaitStatus;
  responseArtifact?: RunArtifact;
  lastError?: string;
}

const activeProviderWaitStatuses = new Set<ProviderWaitStatus>(["pending_post", "posted_waiting"]);

const createEvent = (type: string, message: string, data?: JsonObject): RunEvent => ({
  id: newId("event"),
  createdAt: nowIso(),
  type,
  message,
  ...(data ? { data } : {})
});

const hashText = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const uniqueStrings = (values: string[]): string[] =>
  [...new Set(values)];

const waitKey = (
  runId: string,
  role: RuntimeRole,
  assignment: RoleAssignment,
  directive: AgentDirective
): string =>
  [
    runId,
    role,
    assignment.provider,
    assignment.model,
    directive.directiveAck.runId,
    directive.directiveAck.nonce,
    directive.directiveAck.responseField
  ].join(":");

export const providerWaitIsActive = (wait: ProviderWaitRecord): boolean =>
  activeProviderWaitStatuses.has(wait.status);

export const activeProviderWaits = (run: RunRecord): ProviderWaitRecord[] =>
  (run.providerWaits ?? []).filter(providerWaitIsActive);

export const latestActiveProviderWait = (run: RunRecord): ProviderWaitRecord | undefined =>
  activeProviderWaits(run).at(-1);

export const providerWaitLabel = (wait: ProviderWaitRecord): string =>
  `${wait.role} waiting on ${wait.provider}:${wait.model} (${wait.status})`;

const providerWaitEventData = (wait: ProviderWaitRecord): JsonObject => ({
  waitId: wait.id,
  status: wait.status,
  role: wait.role,
  provider: wait.provider,
  model: wait.model,
  directiveAck: wait.directiveAck as unknown as JsonObject,
  artifactRefs: wait.artifactRefs
});

const waitArtifactName = (wait: ProviderWaitRecord): string =>
  `${wait.role}-${wait.provider}-${newId("provider-wait")}.json`;

const writeProviderWaitArtifact = async (
  run: RunRecord,
  wait: ProviderWaitRecord,
  summary: string
): Promise<RunArtifact> =>
  writeRunArtifact({
    repoPath: run.repoPath,
    runId: run.runId,
    kind: "provider_wait",
    name: waitArtifactName(wait),
    content: `${JSON.stringify(wait, null, 2)}\n`,
    summary
  });

const upsertWait = (
  waits: ProviderWaitRecord[],
  wait: ProviderWaitRecord
): ProviderWaitRecord[] => {
  const index = waits.findIndex((candidate) => candidate.id === wait.id);

  if (index < 0) {
    return [...waits, wait];
  }

  return waits.map((candidate, candidateIndex) => candidateIndex === index ? wait : candidate);
};

const findWaitByKey = (
  run: RunRecord,
  idempotencyKey: string
): ProviderWaitRecord | undefined =>
  (run.providerWaits ?? []).find((wait) => wait.idempotencyKey === idempotencyKey);

const findWait = (run: RunRecord, waitId: string): ProviderWaitRecord | undefined =>
  (run.providerWaits ?? []).find((wait) => wait.id === waitId);

export const beginProviderWait = async (
  input: BeginProviderWaitInput
): Promise<{ run: RunRecord; wait: ProviderWaitRecord; created: boolean }> => {
  const idempotencyKey = waitKey(input.run.runId, input.role, input.assignment, input.directive);
  const latest = await loadRun(input.run.repoPath, input.run.runId);
  const existing = findWaitByKey(latest, idempotencyKey);

  if (existing) {
    return {
      run: latest,
      wait: existing,
      created: false
    };
  }

  const now = nowIso();
  const wait: ProviderWaitRecord = {
    schemaVersion: 1,
    id: newId("provider_wait"),
    idempotencyKey,
    runId: input.run.runId,
    role: input.role,
    provider: input.assignment.provider,
    model: input.assignment.model,
    directiveAck: {
      runId: input.directive.directiveAck.runId,
      nonce: input.directive.directiveAck.nonce,
      responseField: input.directive.directiveAck.responseField
    },
    directiveArtifactRef: input.directiveArtifact.ref,
    promptHash: hashText(JSON.stringify(input.directive)),
    status: "pending_post",
    createdAt: now,
    updatedAt: now,
    attemptCount: 1,
    artifactRefs: [input.directiveArtifact.ref]
  };
  const artifact = await writeProviderWaitArtifact(
    latest,
    wait,
    `${input.role} provider wait pending for ${input.assignment.provider}:${input.assignment.model}.`
  );
  const waitWithArtifact: ProviderWaitRecord = {
    ...wait,
    artifactRefs: uniqueStrings([...wait.artifactRefs, artifact.ref])
  };
  const updated: RunRecord = {
    ...latest,
    updatedAt: nowIso(),
    providerWaits: [...(latest.providerWaits ?? []), waitWithArtifact],
    artifacts: [...latest.artifacts, artifact],
    events: [
      ...latest.events,
      createEvent("provider_wait_started", providerWaitLabel(waitWithArtifact), providerWaitEventData(waitWithArtifact))
    ]
  };

  await saveRun(updated);

  return {
    run: updated,
    wait: waitWithArtifact,
    created: true
  };
};

const updateProviderWait = async (
  repoPath: string,
  runId: string,
  waitId: string,
  input: CompleteProviderWaitInput & { eventType: string; summary: string; target?: ProviderWaitTarget }
): Promise<RunRecord> => {
  const latest = await loadRun(repoPath, runId);
  const current = findWait(latest, waitId);

  if (!current) {
    return latest;
  }

  const now = nowIso();
  const wait: ProviderWaitRecord = {
    ...current,
    status: input.status,
    updatedAt: now,
    ...(input.status === "posted_waiting" && !current.postedAt ? { postedAt: now } : {}),
    ...(input.status === "ingested" || input.status === "failed" || input.status === "target_lost" || input.status === "superseded"
      ? { completedAt: now }
      : {}),
    ...(input.target ? { target: input.target } : {}),
    ...(input.responseArtifact ? { artifactRefs: uniqueStrings([...current.artifactRefs, input.responseArtifact.ref]) } : {}),
    ...(input.lastError ? { lastError: input.lastError } : {})
  };
  const artifact = await writeProviderWaitArtifact(latest, wait, input.summary);
  const waitWithArtifact: ProviderWaitRecord = {
    ...wait,
    artifactRefs: uniqueStrings([...wait.artifactRefs, artifact.ref])
  };
  const updated: RunRecord = {
    ...latest,
    updatedAt: nowIso(),
    providerWaits: upsertWait(latest.providerWaits ?? [], waitWithArtifact),
    artifacts: [...latest.artifacts, artifact],
    events: [
      ...latest.events,
      createEvent(input.eventType, input.summary, providerWaitEventData(waitWithArtifact))
    ]
  };

  await saveRun(updated);
  return updated;
};

export const markProviderWaitPosted = async (input: MarkProviderWaitPostedInput): Promise<RunRecord> => {
  const idempotencyKey = waitKey(input.run.runId, input.role, input.assignment, input.directive);
  const latest = await loadRun(input.run.repoPath, input.run.runId);
  const wait = findWaitByKey(latest, idempotencyKey);

  if (!wait || wait.status !== "pending_post") {
    return latest;
  }

  return updateProviderWait(latest.repoPath, latest.runId, wait.id, {
    status: "posted_waiting",
    eventType: "provider_wait_posted",
    summary: `${input.role} prompt posted to ${input.assignment.provider}:${input.assignment.model}; waiting for response.`,
    ...(input.target ? { target: input.target } : {})
  });
};

export const completeProviderWait = async (
  run: RunRecord,
  waitId: string,
  input: CompleteProviderWaitInput
): Promise<RunRecord> =>
  updateProviderWait(run.repoPath, run.runId, waitId, {
    ...input,
    eventType: input.status === "failed" ? "provider_wait_failed" : "provider_wait_completed",
    summary: input.status === "failed"
      ? `Provider wait failed for ${waitId}.`
      : `Provider wait completed for ${waitId}.`
  });
