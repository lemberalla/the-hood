import { writeRunArtifact } from "./artifacts.js";
import { deriveCrewLaneTrail } from "./crewLanes.js";
import { newId, nowIso } from "./ids.js";
import { deriveLoopResponsibilitySchedule } from "./loopResponsibilities.js";
import { deriveOperatorNextActions } from "./operatorNextActions.js";
import { deriveReviewLanes } from "./reviewLanes.js";
import { loadRun, saveRun } from "./store.js";
import {
  runtimeRoles,
  type ApprovalEvent,
  type CrewLane,
  type JsonObject,
  type JsonValue,
  type LoopResponsibility,
  type OperatorNextAction,
  type ProgressPacket,
  type ProgressPacketApproval,
  type ProgressPacketArtifactRef,
  type ProgressPacketBoundedSection,
  type ProgressPacketBounds,
  type ProgressPacketEvidenceGroup,
  type ProgressPacketLimits,
  type ProgressPacketOpenQuestion,
  type ProgressPacketProviderResponse,
  type ProgressPacketRunEvent,
  type ProgressPacketSourceRef,
  type ProgressPacketToolEvidence,
  type RunArtifact,
  type RunArtifactKind,
  type RunEvent,
  type RunRecord,
  type RoleMap,
  type RuntimeRole,
  type ToolEvent
} from "./types.js";

export const defaultProgressPacketLimits: ProgressPacketLimits = {
  maxArtifacts: 40,
  maxProviderResponses: 20,
  maxApprovalEvents: 20,
  maxToolEvents: 40,
  maxRunEvents: 60,
  maxOpenQuestions: 20,
  maxReviewLanes: 12,
  maxOperatorNextActions: 8,
  maxLoopResponsibilities: 12,
  maxCrewLanes: 12,
  maxStringLength: 1000
};

const ontologyTerms = [
  "Run",
  "Plan",
  "Slice",
  "Task",
  "Agent",
  "Role",
  "Artifact",
  "Evidence",
  "Approval",
  "Commit",
  "Validation",
  "VerifierVerdict",
  "ReviewLane",
  "ReviewOwner",
  "ReviewGate",
  "SidecarEvidence",
  "QA",
  "CriticTrigger",
  "RevisionPacket",
  "LoopResponsibility",
  "LoopResponsibilitySchedule",
  "CrewLane",
  "CrewLaneTrail",
  "OperatorNextAction",
  "OperatorActionOwner",
  "Reconciliation",
  "Decision"
];

interface ProgressPacketBuildState {
  limits: ProgressPacketLimits;
  bounds: ProgressPacketBounds;
}

export interface BuildProgressPacketInput {
  limits?: Partial<ProgressPacketLimits>;
}

export interface WriteProgressPacketArtifactResult {
  run: RunRecord;
  artifact: RunArtifact;
  packet: ProgressPacket;
}

const progressPacketArtifactKind: RunArtifactKind = "progress";

const mergeLimits = (limits: Partial<ProgressPacketLimits> | undefined): ProgressPacketLimits => ({
  ...defaultProgressPacketLimits,
  ...limits
});

const createBuildState = (limits: ProgressPacketLimits): ProgressPacketBuildState => ({
  limits,
  bounds: {
    limits,
    sections: {},
    truncated: false,
    textFieldsTruncated: 0
  }
});

const markTextTruncated = (state: ProgressPacketBuildState): void => {
  state.bounds.truncated = true;
  state.bounds.textFieldsTruncated += 1;
};

const truncateText = (value: string, state: ProgressPacketBuildState): string => {
  if (value.length <= state.limits.maxStringLength) {
    return value;
  }

  markTextTruncated(state);
  const suffix = "...[truncated]";
  const prefixLength = Math.max(0, state.limits.maxStringLength - suffix.length);
  return `${value.slice(0, prefixLength)}${suffix}`;
};

const boundedSection = <Input, Output>(
  name: string,
  items: Input[],
  limit: number,
  state: ProgressPacketBuildState,
  mapItem: (item: Input) => Output
): ProgressPacketBoundedSection<Output> => {
  const omitted = Math.max(0, items.length - limit);
  const selected = items.slice(omitted);
  const truncated = omitted > 0;

  if (truncated) {
    state.bounds.truncated = true;
  }

  state.bounds.sections[name] = {
    included: selected.length,
    omitted,
    truncated
  };

  return {
    items: selected.map(mapItem),
    omitted,
    truncated
  };
};

const runSource = (run: RunRecord): ProgressPacketSourceRef => ({
  kind: "run_record",
  runId: run.runId
});

const artifactSource = (run: RunRecord, artifact: RunArtifact): ProgressPacketSourceRef => ({
  kind: "run_artifact",
  runId: run.runId,
  ref: artifact.ref
});

const approvalSource = (run: RunRecord, event: ApprovalEvent): ProgressPacketSourceRef => ({
  kind: "approval_event",
  runId: run.runId,
  id: event.id
});

const toolSource = (run: RunRecord, event: ToolEvent): ProgressPacketSourceRef => ({
  kind: "tool_event",
  runId: run.runId,
  id: event.id
});

const eventSource = (run: RunRecord, event: RunEvent): ProgressPacketSourceRef => ({
  kind: "run_event",
  runId: run.runId,
  id: event.id,
  eventType: event.type
});

const artifactRef = (
  run: RunRecord,
  artifact: RunArtifact,
  state: ProgressPacketBuildState
): ProgressPacketArtifactRef => ({
  kind: artifact.kind,
  ref: artifact.ref,
  summary: truncateText(artifact.summary, state),
  canonical: true,
  source: artifactSource(run, artifact)
});

const compactJsonObject = (
  value: JsonObject | undefined,
  state: ProgressPacketBuildState
): JsonObject | undefined => {
  if (!value) {
    return undefined;
  }

  const raw = JSON.stringify(value);
  if (raw.length <= state.limits.maxStringLength) {
    return JSON.parse(raw) as JsonObject;
  }

  return {
    truncated: true,
    preview: truncateText(raw, state)
  };
};

const runEventRef = (
  run: RunRecord,
  event: RunEvent,
  state: ProgressPacketBuildState
): ProgressPacketRunEvent => {
  const data = compactJsonObject(event.data, state);
  const mapped: ProgressPacketRunEvent = {
    id: event.id,
    createdAt: event.createdAt,
    type: event.type,
    message: truncateText(event.message, state),
    source: eventSource(run, event)
  };

  if (data) {
    mapped.data = data;
  }

  return mapped;
};

const approvalRef = (
  run: RunRecord,
  event: ApprovalEvent,
  state: ProgressPacketBuildState
): ProgressPacketApproval => ({
  id: event.id,
  createdAt: event.createdAt,
  decision: event.decision,
  reason: truncateText(event.reason, state),
  source: approvalSource(run, event)
});

const toolEventRef = (
  run: RunRecord,
  event: ToolEvent,
  state: ProgressPacketBuildState
): ProgressPacketToolEvidence => {
  const mapped: ProgressPacketToolEvidence = {
    id: event.id,
    createdAt: event.createdAt,
    tool: truncateText(event.tool, state),
    command: truncateText(event.command, state),
    args: event.args.map((arg) => truncateText(arg, state)),
    cwd: truncateText(event.cwd, state),
    exitCode: event.exitCode,
    durationMs: event.durationMs,
    safetyCategory: event.safetyCategory,
    permissionDecision: event.permissionDecision,
    source: toolSource(run, event)
  };

  if (event.stdoutRef) {
    mapped.stdoutRef = event.stdoutRef;
  }

  if (event.stderrRef) {
    mapped.stderrRef = event.stderrRef;
  }

  return mapped;
};

const stringField = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const roleField = (value: JsonValue | undefined): RuntimeRole | undefined =>
  typeof value === "string" && runtimeRoles.includes(value as RuntimeRole)
    ? value as RuntimeRole
    : undefined;

const providerResponseArtifacts = (run: RunRecord): RunArtifact[] =>
  run.artifacts.filter(
    (artifact) => artifact.kind === "plan" || artifact.kind === "agent" || artifact.kind === "reconciliation"
  );

const providerResponseEvents = (run: RunRecord): RunEvent[] =>
  run.events.filter((event) => event.type === "agent_response" || event.type === "reconciliation_response");

const cloneRoleMapping = (roleMapping: RoleMap): RoleMap =>
  Object.fromEntries(
    Object.entries(roleMapping).map(([role, assignment]) => [
      role,
      {
        ...assignment
      }
    ])
  ) as RoleMap;

const mapProviderResponses = (
  run: RunRecord,
  state: ProgressPacketBuildState
): ProgressPacketProviderResponse[] => {
  const artifacts = providerResponseArtifacts(run);

  return providerResponseEvents(run).map((event, index) => {
    const artifact = artifacts[index];
    const data = event.data ?? {};
    const mappedEvent = runEventRef(run, event, state);
    const mappedArtifact = artifact ? artifactRef(run, artifact, state) : undefined;
    const sourceRefs = [
      mappedEvent.source,
      ...(mappedArtifact ? [mappedArtifact.source] : [])
    ];
    const response: ProgressPacketProviderResponse = {
      summary: mappedArtifact?.summary ?? mappedEvent.message,
      event: mappedEvent,
      sourceRefs
    };
    const role = roleField(data.role);
    const provider = stringField(data.provider);
    const model = stringField(data.model);
    const status = stringField(data.status);

    if (role) {
      response.role = role;
    }

    if (provider) {
      response.provider = truncateText(provider, state);
    }

    if (model) {
      response.model = truncateText(model, state);
    }

    if (status) {
      response.status = truncateText(status, state);
    }

    if (mappedArtifact) {
      response.artifact = mappedArtifact;
    }

    return response;
  });
};

const latestArtifact = (
  artifacts: ProgressPacketArtifactRef[],
  predicate: (artifact: ProgressPacketArtifactRef) => boolean
): ProgressPacketArtifactRef | undefined => artifacts.filter(predicate).at(-1);

const finalReportArtifact = (artifacts: ProgressPacketArtifactRef[]): ProgressPacketArtifactRef | undefined =>
  artifacts
    .filter((artifact) => artifact.kind === "report" && artifact.summary.includes("Final report"))
    .at(-1);

const createEvidenceGroup = (
  name: string,
  input: {
    artifacts: RunArtifact[];
    events: RunEvent[];
    toolEvents: ToolEvent[];
  },
  run: RunRecord,
  state: ProgressPacketBuildState
): ProgressPacketEvidenceGroup => ({
  artifacts: boundedSection(
    `${name}.artifacts`,
    input.artifacts,
    state.limits.maxArtifacts,
    state,
    (artifact) => artifactRef(run, artifact, state)
  ),
  events: boundedSection(
    `${name}.events`,
    input.events,
    state.limits.maxRunEvents,
    state,
    (event) => runEventRef(run, event, state)
  ),
  toolEvents: boundedSection(
    `${name}.toolEvents`,
    input.toolEvents,
    state.limits.maxToolEvents,
    state,
    (event) => toolEventRef(run, event, state)
  )
});

const isGitToolEvent = (event: ToolEvent): boolean => event.tool === "git_status" || event.tool === "git_diff";

const isGitArtifact = (artifact: RunArtifact): boolean => artifact.summary.includes("Git evidence summary");

const isValidationToolEvent = (event: ToolEvent): boolean => event.tool.startsWith("validation_");

const isValidationArtifact = (artifact: RunArtifact): boolean => artifact.summary.includes("Validation summary");

const openQuestions = (
  run: RunRecord,
  providerResponses: ProgressPacketProviderResponse[],
  state: ProgressPacketBuildState
): ProgressPacketOpenQuestion[] => {
  const questions: ProgressPacketOpenQuestion[] = [];
  const source = runSource(run);

  if (run.approvalRequired) {
    questions.push({
      severity: "blocking",
      question: truncateText(`Run is waiting for approval: ${run.approvalReason ?? "no reason recorded"}`, state),
      sourceRefs: [source]
    });
  }

  if (run.state !== "completed") {
    questions.push({
      severity: "info",
      question: truncateText(`Run state is ${run.state}; do not assume implementation is accepted.`, state),
      sourceRefs: [source]
    });
  }

  if (run.stopReason && run.state !== "completed") {
    questions.push({
      severity: run.state === "failed" || run.state === "aborted" ? "blocking" : "risk",
      question: truncateText(`Stop reason is still active: ${run.stopReason}`, state),
      sourceRefs: [source]
    });
  }

  for (const event of run.toolEvents.filter((candidate) => candidate.exitCode !== 0)) {
    questions.push({
      severity: "blocking",
      question: truncateText(`Tool ${event.tool} exited with ${event.exitCode}.`, state),
      sourceRefs: [toolSource(run, event)]
    });
  }

  for (const response of providerResponses.filter((candidate) => candidate.status === "blocked" || candidate.status === "failed")) {
    questions.push({
      severity: response.status === "failed" ? "blocking" : "risk",
      question: truncateText(`Provider response is ${response.status}: ${response.summary}`, state),
      sourceRefs: response.sourceRefs
    });
  }

  return questions;
};

const uniqueSources = (sources: ProgressPacketSourceRef[]): ProgressPacketSourceRef[] => {
  const seen = new Set<string>();
  const unique: ProgressPacketSourceRef[] = [];

  for (const source of sources) {
    const key = [
      source.kind,
      source.runId,
      source.id ?? "",
      source.ref ?? "",
      source.eventType ?? ""
    ].join("\u0000");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(source);
  }

  return unique;
};

export const buildProgressPacket = (
  run: RunRecord,
  input: BuildProgressPacketInput = {}
): ProgressPacket => {
  const state = createBuildState(mergeLimits(input.limits));
  const artifacts = boundedSection(
    "artifacts",
    run.artifacts,
    state.limits.maxArtifacts,
    state,
    (artifact) => artifactRef(run, artifact, state)
  );
  const approvals = boundedSection(
    "approvals",
    run.approvalEvents,
    state.limits.maxApprovalEvents,
    state,
    (event) => approvalRef(run, event, state)
  );
  const toolEvents = boundedSection(
    "toolEvents",
    run.toolEvents,
    state.limits.maxToolEvents,
    state,
    (event) => toolEventRef(run, event, state)
  );
  const runEvents = boundedSection(
    "runEvents",
    run.events,
    state.limits.maxRunEvents,
    state,
    (event) => runEventRef(run, event, state)
  );
  const providerResponses = boundedSection(
    "providerResponses",
    mapProviderResponses(run, state),
    state.limits.maxProviderResponses,
    state,
    (response) => response
  );
  const verifierVerdicts = boundedSection(
    "verifierVerdicts",
    providerResponses.items.filter((response) => response.role === "verifier"),
    state.limits.maxProviderResponses,
    state,
    (response) => response
  );
  const git = createEvidenceGroup(
    "git",
    {
      artifacts: run.artifacts.filter(isGitArtifact),
      events: run.events.filter((event) => event.type === "git_evidence_captured"),
      toolEvents: run.toolEvents.filter(isGitToolEvent)
    },
    run,
    state
  );
  const validation = createEvidenceGroup(
    "validation",
    {
      artifacts: run.artifacts.filter(isValidationArtifact),
      events: run.events.filter((event) => event.type === "validation_evidence_captured"),
      toolEvents: run.toolEvents.filter(isValidationToolEvent)
    },
    run,
    state
  );
  const questions = boundedSection(
    "openQuestions",
    openQuestions(run, providerResponses.items, state),
    state.limits.maxOpenQuestions,
    state,
    (question) => question
  );
  const reviewLanes = boundedSection(
    "reviewLanes",
    deriveReviewLanes(run),
    state.limits.maxReviewLanes,
    state,
    (lane) => ({
      ...lane,
      summary: truncateText(lane.summary, state)
    })
  );
  const operatorNextActions = boundedSection(
    "operatorNextActions",
    deriveOperatorNextActions(run),
    state.limits.maxOperatorNextActions,
    state,
    (nextAction): OperatorNextAction => ({
      ...nextAction,
      label: truncateText(nextAction.label, state),
      description: truncateText(nextAction.description, state),
      reason: truncateText(nextAction.reason, state),
      ...(nextAction.artifact
        ? {
            artifact: {
              ...nextAction.artifact,
              summary: truncateText(nextAction.artifact.summary, state)
            }
          }
        : {})
    })
  );
  const loopResponsibilities = boundedSection(
    "loopResponsibilities",
    deriveLoopResponsibilitySchedule(run).responsibilities,
    state.limits.maxLoopResponsibilities,
    state,
    (item): LoopResponsibility => ({
      ...item,
      label: truncateText(item.label, state),
      reason: truncateText(item.reason, state),
      owner: {
        ...item.owner,
        label: truncateText(item.owner.label, state),
        ...(item.owner.assignment ? { assignment: truncateText(item.owner.assignment, state) } : {})
      }
    })
  );
  const crewLanes = boundedSection(
    "crewLanes",
    deriveCrewLaneTrail(run).lanes,
    state.limits.maxCrewLanes,
    state,
    (lane): CrewLane => ({
      ...lane,
      label: truncateText(lane.label, state),
      summary: truncateText(lane.summary, state),
      owner: {
        ...lane.owner,
        label: truncateText(lane.owner.label, state),
        ...(lane.owner.assignment ? { assignment: truncateText(lane.owner.assignment, state) } : {})
      }
    })
  );
  const latestPlan = latestArtifact(artifacts.items, (artifact) => artifact.kind === "plan");
  const latestProviderResponse = providerResponses.items.at(-1);
  const latestProviderExecution = latestArtifact(artifacts.items, (artifact) => artifact.kind === "provider_invocation");
  const latestVerifierResponse = providerResponses.items.filter((response) => response.role === "verifier").at(-1);
  const latestCriticTrigger = latestArtifact(artifacts.items, (artifact) => artifact.kind === "critic_trigger");
  const latestRevisionPacket = latestArtifact(artifacts.items, (artifact) => artifact.kind === "revision_packet");
  const latestFinalReport = finalReportArtifact(artifacts.items);
  const latestRepoContext = latestArtifact(artifacts.items, (artifact) => artifact.kind === "context");
  const latest = {
    ...(latestPlan ? { plan: latestPlan } : {}),
    ...(latestProviderResponse ? { providerResponse: latestProviderResponse } : {}),
    ...(latestProviderExecution ? { providerExecution: latestProviderExecution } : {}),
    ...(latestVerifierResponse ? { verifierResponse: latestVerifierResponse } : {}),
    ...(latestCriticTrigger ? { criticTrigger: latestCriticTrigger } : {}),
    ...(latestRevisionPacket ? { revisionPacket: latestRevisionPacket } : {}),
    ...(latestFinalReport ? { finalReport: latestFinalReport } : {}),
    ...(latestRepoContext ? { repoContext: latestRepoContext } : {})
  };
  const canonicalSources = uniqueSources([
    runSource(run),
    ...artifacts.items.map((artifact) => artifact.source),
    ...approvals.items.map((approval) => approval.source),
    ...toolEvents.items.map((event) => event.source),
    ...runEvents.items.map((event) => event.source),
    ...providerResponses.items.flatMap((response) => response.sourceRefs),
    ...reviewLanes.items.flatMap((lane) => lane.sourceRefs),
    ...loopResponsibilities.items.flatMap((item) => [
      ...item.eventRefs.map((id): ProgressPacketSourceRef => ({ kind: "run_event", runId: run.runId, id })),
      ...item.artifactRefs.map((ref): ProgressPacketSourceRef => ({ kind: "run_artifact", runId: run.runId, ref }))
    ]),
    ...crewLanes.items.flatMap((lane) => lane.sourceRefs),
    ...questions.items.flatMap((question) => question.sourceRefs)
  ]);

  return {
    schemaVersion: 1,
    kind: "progress_packet",
    ontologyVersion: "initial",
    ontologyTerms,
    run: {
      runId: run.runId,
      repoPath: run.repoPath,
      userGoal: truncateText(run.userGoal, state),
      mode: run.mode,
      state: run.state,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      approvalRequired: run.approvalRequired,
      ...(run.approvalReason ? { approvalReason: truncateText(run.approvalReason, state) } : {}),
      ...(run.stopReason ? { stopReason: truncateText(run.stopReason, state) } : {}),
      maxIterations: run.maxIterations,
      artifactCount: run.artifacts.length,
      approvalEventCount: run.approvalEvents.length,
      toolEventCount: run.toolEvents.length,
      runEventCount: run.events.length,
      providerResponseCount: providerResponseEvents(run).length,
      source: runSource(run)
    },
    roleMapping: cloneRoleMapping(run.roleMapping),
    latest,
    reviewLanes,
    operatorNextActions,
    loopResponsibilities,
    crewLanes,
    evidence: {
      artifacts,
      providerResponses,
      approvals,
      toolEvents,
      runEvents,
      git,
      validation,
      verifierVerdicts
    },
    openQuestions: questions,
    provenance: {
      canonicalSources,
      derivedFields: [
        "latest",
        "latest.providerExecution",
        "evidence.providerResponses",
        "evidence.git",
        "evidence.validation",
        "evidence.verifierVerdicts",
        "reviewLanes",
        "operatorNextActions",
        "loopResponsibilities",
        "crewLanes",
        "openQuestions"
      ],
      notes: [
        "Progress packet was built from the RunRecord passed to buildProgressPacket.",
        "Artifact refs, event ids, approval ids, and tool event ids are canonical evidence.",
        "Summaries and open questions are derived navigation aids and are not authoritative without their source refs.",
        "No providers, commands, network requests, or artifact file reads are performed by this builder."
      ]
    },
    bounds: state.bounds
  };
};

export const writeProgressPacketArtifact = async (
  run: RunRecord
): Promise<WriteProgressPacketArtifactResult> => {
  const latest = await loadRun(run.repoPath, run.runId);
  const packet = buildProgressPacket(latest);
  const artifact = await writeRunArtifact({
    repoPath: latest.repoPath,
    runId: latest.runId,
    kind: progressPacketArtifactKind,
    name: `progress-${newId("progress")}.json`,
    content: `${JSON.stringify(packet, null, 2)}\n`,
    summary: `Progress packet for ${latest.state} ${latest.mode} run.`
  });
  const current = await loadRun(latest.repoPath, latest.runId);
  const eventCreatedAt = nowIso();
  const updated: RunRecord = {
    ...current,
    updatedAt: eventCreatedAt,
    artifacts: [...current.artifacts, artifact],
    events: [
      ...current.events,
      {
        id: newId("event"),
        createdAt: eventCreatedAt,
        type: "progress_packet_written",
        message: "Wrote runtime progress packet.",
        data: {
          artifactRef: artifact.ref,
          artifactSummary: artifact.summary,
          packetKind: packet.kind
        }
      }
    ]
  };

  await saveRun(updated);

  return {
    run: updated,
    artifact,
    packet
  };
};
