import { approvalMessageHint } from "./approvalInbox.js";
import { roleLaneLabel } from "./handoffs.js";
import { nowIso } from "./ids.js";
import { latestActiveProviderWait } from "./providerWaits.js";
import { deriveReviewLanes } from "./reviewLanes.js";
import { runtimeRoles } from "./types.js";
import type {
  JsonObject,
  OperatorNextAction,
  OperatorNextActionArtifact,
  OperatorNextActionKind,
  OperatorNextActionOwner,
  ReviewLane,
  RunArtifact,
  RunEvent,
  RunRecord,
  RuntimeRole
} from "./types.js";

const providerResponseEventTypes = new Set(["agent_response", "reconciliation_response", "summon_response"]);

const quoteArg = (value: string): string =>
  /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const roleField = (value: unknown): RuntimeRole | undefined => {
  const role = stringField(value);

  return runtimeRoles.find((candidate) => candidate === role);
};

const latestEvent = (
  run: RunRecord,
  predicate: (event: RunEvent) => boolean
): RunEvent | undefined =>
  run.events.filter(predicate).at(-1);

const eventIsAfter = (left: RunEvent | undefined, right: RunEvent | undefined): boolean =>
  Boolean(left && (!right || left.createdAt > right.createdAt));

const runtimeOwner = (label = "Runtime"): OperatorNextActionOwner => ({
  kind: "runtime",
  label
});

const roleOwner = (role: RuntimeRole): OperatorNextActionOwner => ({
  kind: "role",
  role,
  label: roleLaneLabel(role)
});

const artifactSummary = (artifact: RunArtifact): OperatorNextActionArtifact => ({
  kind: artifact.kind,
  ref: artifact.ref,
  summary: artifact.summary
});

const uniqueStrings = (values: Array<string | undefined>): string[] =>
  [...new Set(values.filter((value): value is string => Boolean(value)))];

const action = (
  run: RunRecord,
  input: {
    action: OperatorNextActionKind;
    label: string;
    description: string;
    owner?: OperatorNextActionOwner;
    blocking?: boolean;
    required?: boolean;
    state?: string;
    reason?: string | undefined;
    artifactRefs?: string[];
    eventRefs?: string[];
    commandHint?: string;
    mcpToolHint?: string;
    tool?: string;
    arguments?: JsonObject;
    artifact?: OperatorNextActionArtifact;
  },
  generatedAt: string
): OperatorNextAction => ({
  action: input.action,
  label: input.label,
  description: input.description,
  owner: input.owner ?? runtimeOwner(),
  blocking: input.blocking ?? false,
  required: input.required ?? false,
  state: input.state ?? run.state,
  reason: input.reason ?? input.description,
  generatedAt,
  artifactRefs: uniqueStrings([
    ...(input.artifactRefs ?? []),
    input.artifact?.ref
  ]),
  eventRefs: uniqueStrings(input.eventRefs ?? []),
  ...(input.commandHint ? { commandHint: input.commandHint } : {}),
  ...(input.mcpToolHint ? { mcpToolHint: input.mcpToolHint } : {}),
  ...(input.tool ? { tool: input.tool } : {}),
  ...(input.arguments ? { arguments: input.arguments } : {}),
  ...(input.artifact ? { artifact: input.artifact } : {})
});

const artifactReadAction = (
  run: RunRecord,
  artifactRef: string,
  description: string,
  generatedAt: string,
  actionKind: OperatorNextActionKind = "inspect_artifact"
): OperatorNextAction | undefined => {
  const artifact = run.artifacts.find((candidate) => candidate.ref === artifactRef);
  if (!artifact) {
    return undefined;
  }

  return action(run, {
    action: actionKind,
    label: artifact.summary,
    description,
    owner: runtimeOwner("Runtime Artifacts"),
    artifactRefs: [artifact.ref],
    commandHint: `thehood artifact ${run.runId} ${quoteArg(artifact.ref)} --repo ${quoteArg(run.repoPath)}`,
    mcpToolHint: "thehood_read_artifact",
    tool: "thehood_read_artifact",
    arguments: {
      repo_path: run.repoPath,
      run_id: run.runId,
      ref: artifact.ref,
      max_bytes: 20000
    },
    artifact: artifactSummary(artifact)
  }, generatedAt);
};

const finalReportActionForRun = (run: RunRecord, generatedAt: string): OperatorNextAction | undefined => {
  const event = latestEvent(run, (candidate) => candidate.type === "final_report_written");
  const artifactRef = stringField(event?.data?.artifactRef);

  return artifactRef
    ? artifactReadAction(run, artifactRef, "Inspect the final report for this completed run.", generatedAt, "inspect_final_report")
    : undefined;
};

const progressPacketActionForRun = (run: RunRecord, generatedAt: string): OperatorNextAction | undefined => {
  const artifact = run.artifacts.filter((candidate) => candidate.kind === "progress").at(-1);

  return artifact
    ? artifactReadAction(run, artifact.ref, "Inspect the progress packet for planner reconciliation.", generatedAt, "inspect_progress_packet")
    : undefined;
};

const approvalArtifactActionsForRun = (run: RunRecord, generatedAt: string): OperatorNextAction[] => {
  const actions: OperatorNextAction[] = [];
  const refs = new Set<string>();
  const addArtifactAction = (artifactRef: unknown, description: string): void => {
    if (typeof artifactRef !== "string" || refs.has(artifactRef)) {
      return;
    }

    const nextAction = artifactReadAction(run, artifactRef, description, generatedAt);
    if (nextAction) {
      refs.add(artifactRef);
      actions.push(nextAction);
    }
  };

  const approvalEvent = latestEvent(run, (event) => event.type === "approval_required");
  addArtifactAction(approvalEvent?.data?.artifactRef, "Inspect the artifact that triggered this approval gate.");
  addArtifactAction(approvalEvent?.data?.sourceArtifactRef, "Inspect the source artifact for this approval gate.");

  if (run.approvalReason?.includes("protected test changes")) {
    const integrationReportEvent = latestEvent(run, (event) => event.type === "integration_report_written");
    addArtifactAction(
      integrationReportEvent?.data?.artifactRef,
      "Inspect the integration report before approving protected path verification."
    );
  }

  return actions;
};

const approvalEventRefs = (run: RunRecord): string[] => {
  const event = latestEvent(run, (candidate) => candidate.type === "approval_required");

  return event ? [event.id] : [];
};

const approvalArtifactRefs = (run: RunRecord): string[] => {
  const event = latestEvent(run, (candidate) => candidate.type === "approval_required");

  return uniqueStrings([
    stringField(event?.data?.artifactRef),
    stringField(event?.data?.sourceArtifactRef)
  ]);
};

const isReconciliationApproval = (run: RunRecord): boolean =>
  Boolean(run.approvalReason?.includes("send progress packet"));

const isTransferApproval = (run: RunRecord): boolean =>
  Boolean(run.approvalReason?.includes("transfer manifest")) ||
  run.artifacts.some((artifact) => artifact.kind === "transfer_manifest");

const providerWaitEvent = (run: RunRecord): RunEvent | undefined => {
  const directive = latestEvent(run, (event) => event.type === "agent_directive_created");
  const response = latestEvent(run, (event) => providerResponseEventTypes.has(event.type));

  return eventIsAfter(directive, response) ? directive : undefined;
};

const reviewActionForLane = (
  run: RunRecord,
  lane: ReviewLane,
  generatedAt: string
): OperatorNextAction | undefined => {
  if (!lane.required || lane.satisfiesRequired) {
    return undefined;
  }

  const owner = lane.role ? roleOwner(lane.role) : runtimeOwner(lane.owner.label);
  const kind: OperatorNextActionKind = lane.kind === "qa" ? "validation_required" : "review_required";

  return action(run, {
    action: kind,
    label: lane.label,
    description: lane.summary,
    owner,
    blocking: true,
    required: true,
    state: lane.state,
    reason: lane.summary,
    artifactRefs: lane.artifactRefs.slice(0, 3),
    eventRefs: lane.eventRefs.slice(0, 3)
  }, generatedAt);
};

export const deriveOperatorNextActions = (run: RunRecord): OperatorNextAction[] => {
  const generatedAt = nowIso();

  if (run.approvalRequired) {
    const approvalRefs = approvalArtifactRefs(run);
    const eventRefs = approvalEventRefs(run);
    const continueTool = isReconciliationApproval(run) ? "thehood_reconcile" : "thehood_continue";
    const continueCommand = continueTool === "thehood_reconcile"
      ? `thehood reconcile ${run.runId} --repo ${quoteArg(run.repoPath)}`
      : `thehood continue ${run.runId} --repo ${quoteArg(run.repoPath)}`;

    return [
      action(run, {
        action: "review_approval_reason",
        label: "Review approval gate",
        description: run.approvalReason ?? "Approval is required before this run can continue.",
        owner: runtimeOwner("Runtime Approval Gate"),
        blocking: true,
        required: true,
        reason: run.approvalReason,
        artifactRefs: approvalRefs,
        eventRefs
      }, generatedAt),
      ...approvalArtifactActionsForRun(run, generatedAt),
      ...(isTransferApproval(run)
        ? [
            action(run, {
              action: "preview_external_transfer",
              label: "Preview external transfer",
              description: "Preview the exact external transfer manifest before approving.",
              owner: runtimeOwner("Runtime Transfer Gate"),
              required: true,
              reason: "External transfer approval should be inspected before approval.",
              commandHint: `thehood transfer preview ${run.runId} --repo ${quoteArg(run.repoPath)}`,
              mcpToolHint: "thehood_transfer_preview",
              tool: "thehood_transfer_preview",
              arguments: {
                repo_path: run.repoPath,
                run_id: run.runId
              },
              artifactRefs: approvalRefs,
              eventRefs
            }, generatedAt)
          ]
        : []),
      action(run, {
        action: "continue_with_approval",
        label: "Approve and continue",
        description: continueTool === "thehood_reconcile"
          ? "After the user explicitly approves this boundary, call thehood_reconcile with approval=approve."
          : "After the user explicitly approves this boundary, call thehood_continue with approval=approve.",
        owner: runtimeOwner("Runtime Approval Gate"),
        required: true,
        reason: run.approvalReason,
        commandHint: continueCommand,
        mcpToolHint: continueTool,
        tool: continueTool,
        arguments: {
          repo_path: run.repoPath,
          run_id: run.runId,
          approval: "approve",
          message: approvalMessageHint(run)
        },
        artifactRefs: approvalRefs,
        eventRefs
      }, generatedAt),
      action(run, {
        action: "reject_or_revise",
        label: "Reject or request revision",
        description: "If the user does not approve, call thehood_continue with approval=reject or approval=revise.",
        owner: runtimeOwner("Runtime Approval Gate"),
        reason: run.approvalReason,
        commandHint: `thehood continue ${run.runId} --repo ${quoteArg(run.repoPath)}`,
        mcpToolHint: "thehood_continue",
        artifactRefs: approvalRefs,
        eventRefs
      }, generatedAt)
    ];
  }

  const waitingDirective = providerWaitEvent(run);
  const activeProviderWait = latestActiveProviderWait(run);
  if (activeProviderWait) {
    const providerLabel = `${activeProviderWait.provider}:${activeProviderWait.model}`;
    const latestWaitEvent = latestEvent(run, (event) => event.data?.waitId === activeProviderWait.id);

    return [
      action(run, {
        action: "wait_for_provider",
        label: "Waiting for provider",
        description: `Waiting on ${activeProviderWait.role} response from ${providerLabel}.`,
        owner: roleOwner(activeProviderWait.role),
        blocking: true,
        required: true,
        reason: activeProviderWait.target?.label ?? activeProviderWait.status,
        artifactRefs: activeProviderWait.artifactRefs.slice(-3),
        eventRefs: latestWaitEvent ? [latestWaitEvent.id] : []
      }, generatedAt),
      action(run, {
        action: "inspect_status",
        label: "Inspect run status",
        description: "Inspect the active provider wait without posting another prompt.",
        owner: runtimeOwner("Runtime Status"),
        commandHint: `thehood status ${run.runId} --repo ${quoteArg(run.repoPath)}`,
        mcpToolHint: "thehood_status",
        tool: "thehood_status",
        arguments: {
          repo_path: run.repoPath,
          run_id: run.runId
        },
        artifactRefs: activeProviderWait.artifactRefs.slice(-3),
        eventRefs: latestWaitEvent ? [latestWaitEvent.id] : []
      }, generatedAt)
    ];
  }

  if (waitingDirective) {
    const role = roleField(waitingDirective.data?.role);
    const provider = stringField(waitingDirective.data?.provider);
    const model = stringField(waitingDirective.data?.model);
    const artifactRef = stringField(waitingDirective.data?.artifactRef);
    const owner = role ? roleOwner(role) : runtimeOwner("Provider");
    const providerLabel = provider && model ? `${provider}:${model}` : "provider";

    return [
      action(run, {
        action: "wait_for_provider",
        label: "Waiting for provider",
        description: `Waiting on ${role ?? "provider"} response from ${providerLabel}.`,
        owner,
        blocking: true,
        required: true,
        reason: waitingDirective.message,
        artifactRefs: artifactRef ? [artifactRef] : [],
        eventRefs: [waitingDirective.id]
      }, generatedAt),
      action(run, {
        action: "inspect_status",
        label: "Inspect run status",
        description: "Inspect events and artifacts while waiting for the provider response.",
        owner: runtimeOwner("Runtime Status"),
        commandHint: `thehood status ${run.runId} --repo ${quoteArg(run.repoPath)}`,
        mcpToolHint: "thehood_status",
        tool: "thehood_status",
        arguments: {
          repo_path: run.repoPath,
          run_id: run.runId
        },
        eventRefs: [waitingDirective.id]
      }, generatedAt)
    ];
  }

  if (run.state === "completed" || run.state === "failed" || run.state === "aborted") {
    const finalReportAction = run.state === "completed" ? finalReportActionForRun(run, generatedAt) : undefined;
    const progressAction = run.state === "completed" ? progressPacketActionForRun(run, generatedAt) : undefined;
    const terminalAction = action(run, {
      action: run.state === "completed"
        ? "terminal_complete"
        : run.state === "failed"
          ? "terminal_failed"
          : "terminal_aborted",
      label: `Run ${run.state}`,
      description: run.stopReason ?? `Run is ${run.state}.`,
      owner: runtimeOwner("Runtime Terminal State"),
      state: run.state,
      reason: run.stopReason
    }, generatedAt);

    return [
      terminalAction,
      ...(finalReportAction ? [finalReportAction] : []),
      ...(progressAction ? [progressAction] : []),
      ...(run.state === "completed"
        ? [
            action(run, {
              action: "reconcile",
              label: "Reconcile completed run",
              description: "Reconcile this completed run against its progress packet.",
              owner: runtimeOwner("Runtime Reconciliation"),
              commandHint: `thehood reconcile ${run.runId} --repo ${quoteArg(run.repoPath)}`,
              mcpToolHint: "thehood_reconcile",
              tool: "thehood_reconcile",
              arguments: {
                repo_path: run.repoPath,
                run_id: run.runId,
                approval: "none"
              }
            }, generatedAt)
          ]
        : []),
      action(run, {
        action: "inspect_artifacts",
        label: "Inspect artifacts",
        description: "Inspect any relevant artifacts with thehood_read_artifact.",
        owner: runtimeOwner("Runtime Artifacts")
      }, generatedAt)
    ];
  }

  const missingReviewActions = deriveReviewLanes(run)
    .map((lane) => reviewActionForLane(run, lane, generatedAt))
    .filter((nextAction): nextAction is OperatorNextAction => Boolean(nextAction));

  return [
    ...missingReviewActions,
    action(run, {
      action: "continue",
      label: "Continue run",
      description: "Call thehood_continue with approval=none. Runtime autopilot will auto-approve bounded gates when policy allows and record approval evidence.",
      owner: runtimeOwner("Runtime Loop"),
      required: missingReviewActions.length === 0,
      blocking: missingReviewActions.length > 0,
      reason: missingReviewActions.length > 0
        ? "Required review or validation evidence is still missing."
        : "Run can advance to the next runtime boundary.",
      commandHint: `thehood continue ${run.runId} --repo ${quoteArg(run.repoPath)}`,
      mcpToolHint: "thehood_continue",
      tool: "thehood_continue",
      arguments: {
        repo_path: run.repoPath,
        run_id: run.runId,
        approval: "none"
      }
    }, generatedAt),
    action(run, {
      action: "inspect_status",
      label: "Inspect run status",
      description: "Call thehood_status to inspect events and artifacts before continuing.",
      owner: runtimeOwner("Runtime Status"),
      commandHint: `thehood status ${run.runId} --repo ${quoteArg(run.repoPath)}`,
      mcpToolHint: "thehood_status",
      tool: "thehood_status",
      arguments: {
        repo_path: run.repoPath,
        run_id: run.runId
      }
    }, generatedAt)
  ];
};
