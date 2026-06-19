import { formatRoleAssignment } from "../runtime/role-assignment.js";
import { agentMarkdownField } from "../providers/markdownPayload.js";
import type { AdvanceRunResult } from "../runtime/loop.js";
import type { RunLoopResult } from "../runtime/loopRunner.js";
import type { FanoutAgentsResult } from "../runtime/fanout.js";
import type { ReconcileRunResult } from "../runtime/reconciliation.js";
import type { SummonAgentResult } from "../runtime/summons.js";
import type { ExternalTransferPreview } from "../runtime/externalTransfer.js";
import type { BrowserStartResult, BrowserStatus, BrowserStopResult } from "../runtime/browserManager.js";
import type { RunCommandResult } from "../runtime/commandRunner.js";
import type { McpConfigReport, McpTunnelConfigReport } from "./mcpConfig.js";
import type { RuntimeHealthReport } from "../runtime/doctor.js";
import type { GitEvidenceResult } from "../runtime/gitEvidence.js";
import type { ProviderDescriptor } from "../runtime/providers.js";
import type { RoleRosterItem } from "../runtime/roleRoster.js";
import type { RunInsights } from "../runtime/runInsights.js";
import { recentRunHandoffSummaries, type RunHandoffSummary } from "../runtime/handoffs.js";
import type {
  LoopResponsibilityStatus,
  ReviewLaneState,
  RoleMap,
  RunRecord,
  TheHoodConfig
} from "../runtime/types.js";

export const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

export interface CliSetupReport {
  commandName: string;
  repoPath: string;
  localBuildCommand: string;
  installedCommand: string;
  oneSessionAlias: string;
  npmLinkCommand: string;
  npmInstallCommand: string;
  localMcpConfigCommand: string;
  installedMcpConfigCommand: string;
  localUiCommand: string;
  installedUiCommand: string;
  notes: string[];
}

const quoteArg = (value: string): string =>
  /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

export const formatRoles = (roles: RoleMap): string =>
  Object.entries(roles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, assignment]) => `${role}: ${formatRoleAssignment(assignment)}`)
    .join("\n");

const rosterSourceLabel = (source: RoleRosterItem["assignmentSource"]): string => {
  if (source === "product_default") {
    return "product default";
  }

  if (source === "repo_config") {
    return "repo config";
  }

  return "not assigned";
};

const rosterStateLabel = (item: RoleRosterItem): string =>
  item.issues.length > 0 ? `${item.state} (${item.issues.join(", ")})` : item.state;

const permissionWord = (value: boolean): string => value ? "yes" : "no";

const formatRosterPermissions = (item: RoleRosterItem): string =>
  [
    `read:${permissionWord(item.permissions.read)}`,
    `edit:${permissionWord(item.permissions.edit)}`,
    `shell:${permissionWord(item.permissions.shell)}`,
    `network:${permissionWord(item.permissions.network)}`
  ].join(" ");

export const formatRoleRoster = (roster: RoleRosterItem[], repoPath: string): string => [
  "Agent Roster",
  ...roster.flatMap((item) => [
    `  ${item.laneLabel}`,
    `    role        ${item.role}`,
    `    owner       ${item.assignmentLabel} (${rosterSourceLabel(item.assignmentSource)})`,
    ...(item.defaultAssignmentLabel && item.assignmentSource !== "product_default"
      ? [`    default     ${item.defaultAssignmentLabel}`]
      : []),
    `    state       ${rosterStateLabel(item)}`,
    `    authority   ${item.authority}`,
    `    tools       ${formatRosterPermissions(item)}`,
    `    purpose     ${item.responsibility}`,
    `    configure   thehood roles set ${item.role} <provider:model> --repo ${quoteArg(repoPath)}`
  ])
].join("\n");

export const formatProviders = (providers: ProviderDescriptor[]): string =>
  providers
    .map((provider) => {
      const state = provider.enabled ? "enabled" : "disabled";
      return `${provider.id} (${state}, ${provider.defaultAccessMode}): ${provider.models.join(", ")} [${provider.accessModes.join(", ")}]`;
    })
    .join("\n");

export const formatDoctorReport = (report: RuntimeHealthReport): string => [
  `runtime: ${report.runtime.name} ${report.runtime.version}`,
  `capabilities: ${report.runtime.capabilities.join(", ")}`,
  "",
  "providers:",
  ...report.providers.map((provider) => {
    const state = provider.issues.length > 0 ? provider.issues.join(", ") : "ready";
    const command = provider.command ? ` command=${provider.command}` : "";
    return `  ${provider.id}: ${state} modes=${provider.accessModes.join(", ")} default=${provider.defaultAccessMode}${command}`;
  }),
  "",
  "roles:",
  ...report.roles.map((role) => {
    const state = role.issues.length > 0 ? role.issues.join(", ") : "ready";
    return `  ${role.role}: ${formatRoleAssignment(role.assignment)} ${state}`;
  })
].join("\n");

export const formatConfig = (config: TheHoodConfig): string => [
  "defaults:",
  `  maxIterations: ${config.defaults.maxIterations}`,
  `  fanoutMaxItems: ${config.defaults.fanoutMaxItems}`,
  `  editRequiresApproval: ${config.defaults.editRequiresApproval}`,
  `  networkRequiresApproval: ${config.defaults.networkRequiresApproval}`,
  "",
  "approval policy:",
  `  mode: ${config.approvalPolicy.mode}`,
  `  externalTransfers: ${config.approvalPolicy.externalTransfers.mode}`,
  `  maxAutoApproveBytes: ${config.approvalPolicy.externalTransfers.maxAutoApproveBytes}`,
  "",
  "roles:",
  formatRoles(config.roles)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
].join("\n");

const formatStringList = (label: string, values: unknown): string[] =>
  Array.isArray(values) && values.every((value) => typeof value === "string")
    ? [
        `${label}:`,
        ...values.map((value) => `  - ${value}`)
      ]
    : [];

const formatDecisionLines = (decision: Record<string, unknown>): string[] => [
  ...(typeof decision.action === "string" ? [`action: ${decision.action}`] : []),
  ...(typeof decision.reason === "string" ? [`reason: ${decision.reason}`] : []),
  ...(typeof decision.milestone === "string" ? [`milestone: ${decision.milestone}`] : []),
  ...formatStringList("buildNext", decision.buildNext),
  ...formatStringList("acceptanceCriteria", decision.acceptanceCriteria),
  ...formatStringList("validationHints", decision.validationHints),
  ...(decision.suggestedDelegation && typeof decision.suggestedDelegation === "object" && !Array.isArray(decision.suggestedDelegation)
    ? [
        "suggestedDelegation:",
        ...Object.entries(decision.suggestedDelegation as Record<string, unknown>)
          .filter(([, value]) => typeof value === "string" || typeof value === "boolean")
          .map(([key, value]) => `  ${key}: ${String(value)}`)
      ]
    : [])
];

const markdownPreviewLineLimit = 24;

const formatAgentMarkdownLines = (
  run: RunRecord,
  response: NonNullable<RunInsights["latestAgentResponse"]>
): string[] => {
  const markdown = response.markdown;

  if (!markdown) {
    return [];
  }

  const previewLines = markdown.preview.trimEnd().split("\n").slice(0, markdownPreviewLineLimit);
  const lineTruncated = markdown.preview.trimEnd().split("\n").length > markdownPreviewLineLimit;
  const truncated = markdown.truncated || lineTruncated;

  return [
    "markdown preview:",
    ...previewLines.map((line) => `  ${line}`),
    ...(truncated ? [`  ... truncated (${markdown.charLength} chars)`] : []),
    `inspect: thehood artifact ${run.runId} ${quoteArg(response.artifact.ref)} --repo ${quoteArg(run.repoPath)}`
  ];
};

const formatPrimaryOutputLines = (insights: RunInsights): string[] => {
  const response = insights.latestAgentResponse;

  if (!response) {
    return [];
  }

  const primary = response.primaryOutput;
  if (!primary) {
    return [];
  }

  if (response.primaryOutputKey === "decision") {
    return formatDecisionLines(primary);
  }

  return Object.entries(primary)
    .filter(([key, value]) =>
      key !== agentMarkdownField &&
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    )
    .map(([key, value]) => `${key}: ${String(value)}`);
};

const formatMemoryRefLines = (insights: RunInsights): string[] => {
  const refs = [
    ["progress", insights.latestProgressPacket],
    ["reconciliation", insights.latestReconciliation],
    ["repoContext", insights.latestRepoContext],
    ["remoteRepoContext", insights.latestRemoteRepoContext],
    ["revisionPacket", insights.latestRevisionPacket?.artifact],
    ["reviewRouting", insights.latestReviewRouting?.artifact],
    ["fanout", insights.latestFanout?.artifact],
    ["transferManifest", insights.latestTransferManifest]
  ] as const;

  return refs.flatMap(([label, artifact]) =>
    artifact ? [`  ${label}: ${artifact.ref}`] : []
  );
};

const formatCriticTriggerLines = (insights: RunInsights): string[] => {
  const trigger = insights.latestCriticTrigger;

  if (!trigger) {
    return [];
  }

  return [
    "critic trigger:",
    ...(trigger.reasonCode ? [`  reasonCode: ${trigger.reasonCode}`] : []),
    ...(trigger.reason ? [`  reason: ${trigger.reason}`] : []),
    ...(trigger.sourceRoles.length > 0 ? [`  sourceRoles: ${trigger.sourceRoles.join(", ")}`] : []),
    `  artifact: ${trigger.artifact.ref}`,
    ...(trigger.criticResponseRef ? [`  criticResponse: ${trigger.criticResponseRef}`] : [])
  ];
};

const formatRevisionPacketLines = (insights: RunInsights): string[] => {
  const packet = insights.latestRevisionPacket;

  if (!packet) {
    return [];
  }

  return [
    "revision packet:",
    ...(packet.sourceRole ? [`  sourceRole: ${packet.sourceRole}`] : []),
    ...(packet.reasonCode ? [`  reasonCode: ${packet.reasonCode}`] : []),
    ...(packet.reason ? [`  reason: ${packet.reason}`] : []),
    ...(packet.repairObjective ? [`  repairObjective: ${packet.repairObjective}`] : []),
    `  artifact: ${packet.artifact.ref}`,
    ...(packet.sourceResponseRef ? [`  sourceResponse: ${packet.sourceResponseRef}`] : []),
    ...(packet.criticTriggerRef ? [`  criticTrigger: ${packet.criticTriggerRef}`] : [])
  ];
};

const formatFanoutLines = (insights: RunInsights): string[] => {
  const fanout = insights.latestFanout;

  if (!fanout) {
    return [];
  }

  return [
    "agent fan-out:",
    ...(fanout.status ? [`  status: ${fanout.status}`] : []),
    ...(fanout.executedItems !== undefined && fanout.requestedItems !== undefined
      ? [`  items: ${fanout.executedItems}/${fanout.requestedItems}`]
      : []),
    `  artifact: ${fanout.artifact.ref}`,
    `  gates: ${fanout.canSatisfyRequiredGates ? "can satisfy required gates" : "advisory only"}`,
    ...fanout.items.slice(0, 6).map((item) =>
      `  - #${item.index + 1} ${item.role ?? "role"} ${item.status ?? "unknown"} ${item.responseArtifactRef ?? ""}`.trimEnd()
    )
  ];
};

const formatReviewRoutingLines = (insights: RunInsights): string[] => {
  const routing = insights.latestReviewRouting;

  if (!routing) {
    return [];
  }

  const required = routing.required ?? {};

  return [
    "review routing:",
    ...(routing.riskTier ? [`  risk: ${routing.riskTier}`] : []),
    ...(routing.action ? [`  action: ${routing.action}`] : []),
    `  required: validation=${String(required.validation ?? true)} qa=${String(required.qa ?? false)} verifier=${String(required.verifier ?? false)} critic=${String(required.critic ?? false)}`,
    ...routing.reasons.slice(0, 4).map((reason) => `  - ${reason}`),
    `  artifact: ${routing.artifact.ref}`
  ];
};

const formatLaneState = (state: ReviewLaneState): string =>
  state.replace(/_/g, " ");

const formatLoopResponsibilityStatus = (status: LoopResponsibilityStatus): string =>
  status.replace(/_/g, " ");

const formatReviewLaneOwner = (owner: RunInsights["reviewLanes"][number]["owner"]): string =>
  owner.assignment ? `${owner.label} (${owner.assignment})` : owner.label;

const formatReviewLaneLines = (insights: RunInsights): string[] =>
  insights.reviewLanes.flatMap((lane) => {
    const satisfaction = lane.required
      ? lane.satisfiesRequired ? "satisfies" : "missing"
      : "advisory";
    const owner = formatReviewLaneOwner(lane.owner);
    const source = lane.canSatisfyRequired ? lane.sourceKind : `${lane.sourceKind}/read-only`;

    return [
      `  ${lane.kind.padEnd(8)} ${formatLaneState(lane.state).padEnd(14)} ${lane.required ? "required" : "optional"}  ${satisfaction}  owner=${owner}  source=${source}`,
      `    ${lane.summary}`,
      ...(lane.artifactRefs[0] ? [`    artifact: ${lane.artifactRefs[0]}`] : []),
      ...(lane.sidecarEvidence.length > 0
        ? [`    sidecar: ${lane.sidecarEvidence.length} read-only summon evidence item(s); cannot satisfy required gates`]
        : [])
    ];
  });

const formatOperatorOwner = (owner: RunInsights["operatorNextActions"][number]["owner"]): string =>
  owner.role ? `${owner.label} (${owner.role})` : owner.label;

const formatLoopResponsibilityOwner = (
  owner: RunInsights["loopResponsibilities"]["responsibilities"][number]["owner"]
): string =>
  owner.assignment ? `${owner.label} (${owner.assignment})` : owner.label;

const formatLoopResponsibilityLines = (insights: RunInsights): string[] =>
  insights.loopResponsibilities.responsibilities.slice(0, 10).flatMap((item) => {
    const status = formatLoopResponsibilityStatus(item.status);
    const gate = item.canSatisfyGate ? "gate" : item.sidecarOnly ? "sidecar" : "view";

    return [
      `  ${item.kind.padEnd(17)} ${status.padEnd(12)} ${item.required ? "required" : "optional"}  ${gate}  owner=${formatLoopResponsibilityOwner(item.owner)}`,
      `    ${item.reason}`,
      ...(item.artifactRefs[0] ? [`    artifact: ${item.artifactRefs[0]}`] : []),
      ...(item.eventRefs[0] ? [`    event: ${item.eventRefs[0]}`] : [])
    ];
  });

const formatOperatorNextActionLines = (insights: RunInsights): string[] =>
  insights.operatorNextActions.slice(0, 6).flatMap((nextAction) => [
    `  ${nextAction.action.padEnd(24)} ${nextAction.blocking ? "blocking" : "ready"}  owner=${formatOperatorOwner(nextAction.owner)}`,
    `    ${nextAction.description}`,
    ...(nextAction.commandHint ? [`    command: ${nextAction.commandHint}`] : []),
    ...(nextAction.tool ? [`    mcp: ${nextAction.tool}`] : []),
    ...(nextAction.artifactRefs[0] ? [`    artifact: ${nextAction.artifactRefs[0]}`] : [])
  ]);

const handoffEndpoint = (
  label: string | undefined,
  assignment: string | undefined,
  fallback: string
): string => {
  const endpoint = label ?? fallback;

  return assignment ? `${endpoint} (${assignment})` : endpoint;
};

const handoffToLabel = (handoff: RunHandoffSummary): string => {
  if (handoff.toLabel) {
    return handoffEndpoint(handoff.toLabel, handoff.toAssignment, "Runtime");
  }

  if (handoff.kind === "approval_gate" || handoff.kind === "approval_auto_approved") {
    return "Approval Gate";
  }

  if (handoff.kind === "completion") {
    return "Completed";
  }

  return "Runtime";
};

const formatHandoffSummary = (handoff: RunHandoffSummary): string => {
  const from = handoffEndpoint(handoff.fromLabel, handoff.fromAssignment, "Runtime");
  const to = handoffToLabel(handoff);
  const gate = handoff.gate ? ` gate=${handoff.gate}` : "";

  return `${handoff.createdAt}  ${handoff.kind}${gate}  ${from} -> ${to}  ${handoff.reason}`;
};

const formatRunInsights = (run: RunRecord, insights?: RunInsights): string[] => {
  if (!insights) {
    return [];
  }

  const response = insights.latestAgentResponse;
  const finalReport = insights.finalReport;
  const autopilotApprovals = insights.recentAutopilotApprovals.slice(0, 5);
  const handoffTimeline = insights.handoffTimeline.slice(-5);
  const memoryRefs = formatMemoryRefLines(insights);
  const criticTrigger = formatCriticTriggerLines(insights);
  const revisionPacket = formatRevisionPacketLines(insights);
  const reviewRouting = formatReviewRoutingLines(insights);
  const fanout = formatFanoutLines(insights);
  const reviewLanes = formatReviewLaneLines(insights);
  const loopResponsibilities = formatLoopResponsibilityLines(insights);
  const operatorNextActions = formatOperatorNextActionLines(insights);

  return [
    ...(response
      ? [
          "",
          "latest agent response:",
          `  status: ${response.status}`,
          `  summary: ${response.summary}`,
          `  artifact: ${response.artifact.ref}`,
          ...formatPrimaryOutputLines(insights).map((line) => `  ${line}`),
          ...formatAgentMarkdownLines(run, response).map((line) => `  ${line}`)
        ]
      : []),
    ...(finalReport
      ? [
          "",
          "final report:",
          `  summary: ${finalReport.artifact.summary}`,
          `  artifact: ${finalReport.artifact.ref}`,
          ...(finalReport.stopReason ? [`  stopReason: ${finalReport.stopReason}`] : []),
          `  inspect: thehood artifact ${run.runId} ${quoteArg(finalReport.artifact.ref)} --repo ${quoteArg(run.repoPath)}`
        ]
      : []),
    ...(memoryRefs.length > 0
      ? [
          "",
          "canonical memory refs:",
          ...memoryRefs
        ]
      : []),
    ...(criticTrigger.length > 0
      ? [
          "",
          ...criticTrigger
        ]
      : []),
    ...(revisionPacket.length > 0
      ? [
          "",
          ...revisionPacket
        ]
      : []),
    ...(reviewRouting.length > 0
      ? [
          "",
          ...reviewRouting
        ]
      : []),
    ...(fanout.length > 0
      ? [
          "",
          ...fanout
        ]
      : []),
    ...(reviewLanes.length > 0
      ? [
          "",
          "review lanes:",
          ...reviewLanes
        ]
      : []),
    ...(loopResponsibilities.length > 0
      ? [
          "",
          "loop responsibilities:",
          ...loopResponsibilities
        ]
      : []),
    ...(operatorNextActions.length > 0
      ? [
          "",
          "operator next actions:",
          ...operatorNextActions
        ]
      : []),
    ...(insights.latestHandoff
      ? [
          "",
          "latest handoff:",
          `  ${formatHandoffSummary(insights.latestHandoff)}`
        ]
      : []),
    ...(handoffTimeline.length > 0
      ? [
          "",
          "handoff timeline:",
          ...handoffTimeline.map((handoff) => `  ${formatHandoffSummary(handoff)}`)
        ]
      : []),
    ...(autopilotApprovals.length > 0
      ? [
          "",
          "recent autopilot approvals:",
          ...autopilotApprovals.flatMap((approval) => [
            `  ${approval.createdAt}  ${approval.gate ?? "autopilot"}  ${approval.policyReason ?? approval.message}`,
            ...(approval.artifact ? [`    artifact: ${approval.artifact.ref}`] : []),
            ...(approval.sourceArtifact ? [`    source: ${approval.sourceArtifact.ref}`] : [])
          ])
        ]
      : []),
    ...(insights.issues.length > 0
      ? [
          "",
          "insight issues:",
          ...insights.issues.map((issue) => `  - ${issue}`)
        ]
      : [])
  ];
};

export const formatRunSummary = (run: RunRecord, insights?: RunInsights): string => {
  const approval = run.approvalRequired
    ? `\napproval: required (${run.approvalReason ?? "no reason recorded"})`
    : "\napproval: not required";

  return [
    `run: ${run.runId}`,
    `state: ${run.state}`,
    `mode: ${run.mode}`,
    `repo: ${run.repoPath}`,
    `goal: ${run.userGoal}`,
    approval,
    "",
    "roles:",
    formatRoles(run.roleMapping)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    ...formatRunInsights(run, insights)
  ].join("\n");
};

export const formatRunList = (runs: RunRecord[]): string => {
  if (runs.length === 0) {
    return "No runs found.";
  }

  return runs
    .map((run) => `${run.runId}  ${run.state}  ${run.mode}  ${run.userGoal}`)
    .join("\n");
};

export const formatRunEvents = (run: RunRecord): string =>
  [
    ...run.events.map((event) => `${event.createdAt}  ${event.type}  ${event.message}`),
    ...((run.handoffs ?? []).length > 0
      ? [
          "",
          "handoffs:",
          ...recentRunHandoffSummaries(run, 10).map((handoff) => formatHandoffSummary(handoff))
        ]
      : [])
  ].join("\n");

export const formatCommandResult = (result: RunCommandResult): string => [
  `command: ${[result.event.command, ...result.event.args].join(" ")}`,
  `exitCode: ${result.event.exitCode}`,
  `cwd: ${result.event.cwd}`,
  `safety: ${result.event.safetyCategory}`,
  `stdout: ${result.event.stdoutRef ?? "none"}`,
  `stderr: ${result.event.stderrRef ?? "none"}`
].join("\n");

export const formatGitEvidence = (result: GitEvidenceResult): string => [
  `changedPaths: ${result.changedPaths.length}`,
  `protectedChanges: ${result.protectedChanges.length}`,
  ...result.changedPaths.map((changedPath) => `  ${changedPath}`),
  ...(result.protectedChanges.length > 0
    ? [
        "",
        "protected:",
        ...result.protectedChanges.map((match) => `  ${match.path} (${match.pattern})`)
      ]
    : [])
].join("\n");

export const formatAdvanceRunResult = (result: AdvanceRunResult): string => [
  formatRunSummary(result.run),
  "",
  `advanced: ${result.advanced}`,
  `stopReason: ${result.stopReason}`,
  `providerResponses: ${result.providerResponses.length}`
].join("\n");

export const formatRunLoopResult = (result: RunLoopResult): string => [
  formatRunSummary(result.run),
  "",
  `advanced: ${result.advanced}`,
  `stopKind: ${result.stopKind}`,
  `stopReason: ${result.stopReason}`,
  `cycles: ${result.cycles.length}/${result.maxCycles}`,
  `maxStepsPerCycle: ${result.maxStepsPerCycle}`,
  `providerResponses: ${result.providerResponses.length}`,
  "",
  "cycle log:",
  ...result.cycles.map((cycle) =>
    `  #${cycle.cycle} state=${cycle.state} advanced=${cycle.advanced} responses=${cycle.providerResponseCount} stop=${cycle.stopReason}`
  )
].join("\n");

export const formatReconcileRunResult = (result: ReconcileRunResult): string => [
  formatRunSummary(result.run),
  "",
  `reconcileRole: ${result.role}`,
  `advanced: ${result.advanced}`,
  `stopReason: ${result.stopReason}`,
  ...(result.progressArtifact
    ? [
        `progress: ${result.progressArtifact.summary}`,
        `progressArtifact: ${result.progressArtifact.ref}`
      ]
    : []),
  ...(result.reconciliationArtifact
    ? [
        `reconciliation: ${result.reconciliationArtifact.summary}`,
        `reconciliationArtifact: ${result.reconciliationArtifact.ref}`,
        `inspect: thehood artifact ${result.run.runId} ${quoteArg(result.reconciliationArtifact.ref)} --repo ${quoteArg(result.run.repoPath)}`
      ]
    : []),
  `providerResponses: ${result.providerResponses.length}`
].join("\n");

export const formatSummonAgentResult = (result: SummonAgentResult): string => [
  formatRunSummary(result.run),
  "",
  `summonRole: ${result.role}`,
  `summonKind: ${result.summonKind}`,
  `agent: ${formatRoleAssignment(result.assignment)}`,
  `advanced: ${result.advanced}`,
  `stopReason: ${result.stopReason}`,
  ...(result.directiveArtifact ? [`directiveArtifact: ${result.directiveArtifact.ref}`] : []),
  ...(result.responseArtifact ? [`responseArtifact: ${result.responseArtifact.ref}`] : []),
  `providerResponses: ${result.providerResponses.length}`
].join("\n");

export const formatFanoutAgentsResult = (result: FanoutAgentsResult): string => [
  formatRunSummary(result.run),
  "",
  `fanoutStatus: ${result.status}`,
  `items: ${result.bounds.executedItems}/${result.bounds.requestedItems}`,
  `maxItems: ${result.bounds.maxItems}`,
  `artifact: ${result.artifact.ref}`,
  ...result.items.map((item) =>
    `  #${item.index + 1} ${item.role}/${item.summonKind} ${item.status}: ${item.stopReason}`
  )
].join("\n");

export const formatExternalTransferPreview = (preview: ExternalTransferPreview): string => [
  `manifest: ${preview.manifestArtifact.ref}`,
  `destination: ${formatRoleAssignment(preview.manifest.destination)}`,
  `purpose: ${preview.manifest.purpose}`,
  `risk: ${preview.manifest.risk.class}`,
  `totalBytes: ${preview.manifest.totalBytes}`,
  `approval: ${preview.manifest.approvalHint}`,
  "",
  "artifacts:",
  ...preview.manifest.artifacts.map((artifact) =>
    `  ${artifact.kind}: ${artifact.summary} (${artifact.byteLength} bytes, sha256 ${artifact.sha256.slice(0, 12)})`
  ),
  "",
  "risk reasons:",
  ...preview.manifest.risk.reasons.map((reason) => `  - ${reason}`),
  "",
  "preview:",
  preview.manifest.preview.content,
  ...(preview.manifest.preview.truncated ? ["", "preview truncated"] : [])
].join("\n");

export const formatMcpConfigReport = (report: McpConfigReport): string => [
  "installed package:",
  report.installedToml,
  "",
  "local build:",
  report.localToml
].join("\n");

export const formatCliSetupReport = (report: CliSetupReport): string => [
  "TheHood CLI Setup",
  "",
  "run this local build:",
  `  ${report.localBuildCommand}`,
  "",
  "temporary shell alias:",
  `  ${report.oneSessionAlias}`,
  "",
  "optional install/link commands:",
  `  ${report.npmLinkCommand}`,
  `  ${report.npmInstallCommand}`,
  "",
  "MCP config:",
  `  local: ${report.localMcpConfigCommand}`,
  `  installed: ${report.installedMcpConfigCommand}`,
  "",
  "TUI:",
  `  local: ${report.localUiCommand}`,
  `  installed: ${report.installedUiCommand}`,
  "",
  "notes:",
  ...report.notes.map((note) => `  - ${note}`)
].join("\n");

export const formatMcpTunnelConfigReport = (report: McpTunnelConfigReport): string => [
  "installed package tunnel:",
  report.installed.initCommand,
  "",
  report.installed.doctorCommand,
  report.installed.runCommand,
  "",
  "local build tunnel:",
  report.local.initCommand,
  "",
  report.local.doctorCommand,
  report.local.runCommand,
  "",
  "ChatGPT connector:",
  ...report.chatGptSteps.map((step) => `  - ${step}`),
  "",
  "notes:",
  ...report.notes.map((note) => `  - ${note}`)
].join("\n");

export const formatBrowserStatus = (status: BrowserStatus): string => [
  `provider: ${status.provider}`,
  `readyForBridge: ${status.readyForBridge}`,
  `cdp: ${status.cdpReachable ? "reachable" : "unreachable"} (${status.cdpUrl})`,
  `chatgptTab: ${status.chatGptTabFound ? "found" : "not found"}`,
  `profile: ${status.profilePath}`,
  ...(status.chromePath ? [`chrome: ${status.chromePath}`] : []),
  ...(status.pid ? [`pid: ${status.pid}`] : []),
  `targets: ${status.targetCount}`,
  `issues: ${status.issues.length > 0 ? status.issues.join(", ") : "none"}`
].join("\n");

export const formatBrowserStartResult = (result: BrowserStartResult): string => [
  `launched: ${result.launched}`,
  formatBrowserStatus(result.status)
].join("\n");

export const formatBrowserStopResult = (result: BrowserStopResult): string => [
  `stopped: ${result.stopped}`,
  ...(result.reason ? [`reason: ${result.reason}`] : []),
  formatBrowserStatus(result.status)
].join("\n");
