import { formatRoleAssignment } from "../runtime/role-assignment.js";
import type {
  ApprovalInboxHandoff,
  ApprovalInboxView,
  AutopilotApproval,
  PendingApproval
} from "../runtime/approvalInbox.js";
import type { BrowserStatus } from "../runtime/browserManager.js";
import type { RuntimeHealthReport } from "../runtime/doctor.js";
import type { RunMonitorItem } from "../runtime/runMonitor.js";
import type { ApprovalPolicy, LoopResponsibilityStatus, ReviewLaneState } from "../runtime/types.js";

export interface DashboardInput {
  repoPath: string;
  health: RuntimeHealthReport;
  browser: BrowserStatus;
  approvalPolicy: ApprovalPolicy;
  runMonitor: RunMonitorItem[];
  approvalInbox: ApprovalInboxView;
}

const wideLogo = [
  " _______ _          _   _                 _ ",
  "|__   __| |        | | | |               | |",
  "   | |  | |__   ___| |_| | ___   ___   __| |",
  "   | |  | '_ \\ / _ \\  _  |/ _ \\ / _ \\ / _` |",
  "   | |  | | | |  __/ | | | (_) | (_) | (_| |",
  "   |_|  |_| |_|\\___|_| |_|\\___/ \\___/ \\__,_|"
];

const compactLogo = [
  "+------------------------------+",
  "| THEHOOD                      |",
  "| local agent runtime          |",
  "+------------------------------+"
];

const terminalWidth = (): number => process.stdout.columns ?? 80;

export const renderHeader = (width = terminalWidth()): string =>
  (width >= 72 ? [...wideLogo, "", "THEHOOD - local agent runtime"] : compactLogo).join("\n");

const statusWord = (ready: boolean): string => ready ? "ready" : "needs attention";

const modeLabel = (value: string): string => value.replace(/_/g, "-");

const quoteArg = (value: string): string =>
  /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

const providerState = (health: RuntimeHealthReport, providerId: string): string => {
  const provider = health.providers.find((candidate) => candidate.id === providerId);
  if (!provider) {
    return "not configured";
  }

  return provider.issues.length === 0 ? "ready" : provider.issues.join(", ");
};

const roleLines = (health: RuntimeHealthReport): string[] =>
  health.roles.map((role) => {
    const state = role.issues.length === 0 ? "ready" : role.issues.join(", ");
    return `  ${role.role.padEnd(12)} ${formatRoleAssignment(role.assignment).padEnd(28)} ${state}`;
  });

const nextActions = (browser: BrowserStatus): string[] => {
  const actions: string[] = [];

  if (!browser.cdpReachable) {
    actions.push("thehood browser start");
  } else if (!browser.chatGptTabFound) {
    actions.push("open ChatGPT in the TheHood browser profile");
  }

  actions.push("thehood doctor --repo <repo>");
  actions.push("thehood plan \"...\"");

  if (browser.readyForBridge) {
    actions.push("thehood plan \"...\" --orchestrator chatgpt-web:chatgpt-pro");
  }

  return actions;
};

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;

const phaseLabel = (phase: RunMonitorItem["phase"]): string =>
  phase.replace(/_/g, " ");

const laneStateLabel = (state: ReviewLaneState): string =>
  state.replace(/_/g, " ");

const loopResponsibilityStatusLabel = (status: LoopResponsibilityStatus): string =>
  status.replace(/_/g, " ");

const laneOwnerLabel = (lane: RunMonitorItem["reviewLanes"][number]): string =>
  lane.owner.assignment ? `${lane.owner.label} (${lane.owner.assignment})` : lane.owner.label;

const laneSatisfactionLabel = (lane: RunMonitorItem["reviewLanes"][number]): string =>
  lane.required
    ? lane.satisfiesRequired ? "satisfies" : "missing"
    : "advisory";

const reviewLaneLines = (run: RunMonitorItem): string[] => {
  if (run.reviewLanes.length === 0) {
    return [];
  }

  return [
    "      reviews",
    ...run.reviewLanes.slice(0, 3).map((lane) =>
      `        ${lane.kind.padEnd(8)} ${laneStateLabel(lane.state).padEnd(14)} ${laneSatisfactionLabel(lane).padEnd(9)} ${truncate(laneOwnerLabel(lane), 72)}`
    )
  ];
};

const loopResponsibilityOwnerLabel = (
  item: RunMonitorItem["loopResponsibilities"][number]
): string =>
  item.owner.assignment ? `${item.owner.label} (${item.owner.assignment})` : item.owner.label;

const loopResponsibilityLines = (run: RunMonitorItem): string[] => {
  if (run.loopResponsibilities.length === 0) {
    return [];
  }

  return [
    "      loop",
    ...run.loopResponsibilities.slice(0, 4).map((item) =>
      `        ${item.kind.padEnd(17)} ${loopResponsibilityStatusLabel(item.status).padEnd(12)} ${truncate(loopResponsibilityOwnerLabel(item), 64)}`
    )
  ];
};

const operatorNextActionLines = (run: RunMonitorItem): string[] => {
  const nextAction = run.operatorNextActions[0];
  if (!nextAction) {
    return [];
  }

  return [
    `      next    ${nextAction.blocking ? "blocked" : "ready"} ${truncate(nextAction.label, 88)}`,
    ...(nextAction.commandHint ? [`      cmd     ${truncate(nextAction.commandHint, 112)}`] : [])
  ];
};

const runMonitorLines = (run: RunMonitorItem, index: number): string[] => {
  const firstArtifactRef = run.artifactRefs[0];

  return [
    `  [${index + 1}] ${run.runId}  ${phaseLabel(run.phase)}  ${run.mode}/${run.state}`,
    `      goal    ${truncate(run.goal, 96)}`,
    `      detail  ${truncate(run.detail, 120)}`,
    ...(run.provider ? [`      agent   ${run.lane ?? "provider"} (${run.provider})`] : []),
    ...(run.gate ? [`      gate    ${run.gate}`] : []),
    ...(firstArtifactRef ? [`      artifact ${truncate(firstArtifactRef, 112)}`] : []),
    ...operatorNextActionLines(run),
    ...loopResponsibilityLines(run),
    ...reviewLaneLines(run)
  ];
};

const approvalCommand = (approval: PendingApproval, command: "approve" | "reject" | "revise"): string => {
  const parts = [
    "thehood",
    "ui",
    "approvals",
    "--repo",
    quoteArg(approval.repoPath),
    `--${command}`,
    approval.runId
  ];

  return parts.join(" ");
};

const transferPreviewCommand = (approval: PendingApproval): string =>
  [
    "thehood",
    "transfer",
    "preview",
    approval.runId,
    "--repo",
    quoteArg(approval.repoPath)
  ].join(" ");

const autopilotTransferPreviewCommand = (approval: AutopilotApproval): string =>
  [
    "thehood",
    "transfer",
    "preview",
    approval.runId,
    "--repo",
    quoteArg(approval.repoPath)
  ].join(" ");

const approvalLines = (approval: PendingApproval, index: number): string[] => [
  `  [${index + 1}] ${approval.runId}  ${approval.mode}  ${approval.state}`,
  `      goal    ${truncate(approval.goal, 96)}`,
  `      reason  ${truncate(approval.reason, 120)}`,
  `      approve ${truncate(approval.suggestedApprovalMessage, 120)}`,
  ...(approval.artifacts.length > 0
    ? [
        "      review",
        ...approval.artifacts.map((artifact) => `        ${artifact.kind}: ${artifact.summary}`)
      ]
    : []),
  ...(approval.artifacts.some((artifact) => artifact.kind === "transfer_manifest")
    ? [`      preview ${transferPreviewCommand(approval)}`]
    : []),
  "      buttons",
  `        [approve] ${approvalCommand(approval, "approve")}`,
  `        [reject]  ${approvalCommand(approval, "reject")}`,
  `        [revise]  ${approvalCommand(approval, "revise")}`,
  `        [resume]  thehood continue ${approval.runId} --repo ${quoteArg(approval.repoPath)}`
];

const autopilotApprovalLines = (approval: AutopilotApproval, index: number): string[] => [
  `  [${index + 1}] ${approval.runId}  ${approval.mode}  ${approval.state}`,
  `      gate    ${approval.gate ?? "autopilot"}`,
  `      goal    ${truncate(approval.goal, 96)}`,
  `      reason  ${truncate(approval.policyReason ?? approval.message, 120)}`,
  ...(approval.artifact
    ? [`      artifact ${approval.artifact.kind}: ${approval.artifact.summary}`]
    : []),
  ...(approval.sourceArtifact
    ? [`      source  ${approval.sourceArtifact.kind}: ${approval.sourceArtifact.summary}`]
    : []),
  ...(approval.artifact?.kind === "transfer_manifest"
    ? [`      preview ${autopilotTransferPreviewCommand(approval)}`]
    : [])
];

const handoffEndpoint = (
  label: string | undefined,
  assignment: string | undefined,
  fallback: string
): string => {
  const endpoint = label ?? fallback;

  return assignment ? `${endpoint} (${assignment})` : endpoint;
};

const handoffDestination = (handoff: ApprovalInboxHandoff): string => {
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

const handoffLines = (handoff: ApprovalInboxHandoff, index: number): string[] => [
  `  [${index + 1}] ${handoff.runId}  ${handoff.state}`,
  `      lane    ${handoffEndpoint(handoff.fromLabel, handoff.fromAssignment, "Runtime")} -> ${handoffDestination(handoff)}`,
  `      gate    ${handoff.gate ?? handoff.kind}`,
  `      goal    ${truncate(handoff.goal, 96)}`,
  `      reason  ${truncate(handoff.reason, 120)}`
];

export const renderApprovalInbox = (inbox: ApprovalInboxView): string => [
  "Approval Gates",
  `  pending ${inbox.pendingApprovals.length}  autopilot ${inbox.recentAutopilotApprovals.length}  handoffs ${inbox.recentHandoffs.length}`,
  "  autopilot still stops for protected test changes, secret-risk transfers, and destructive/dependency/network commands",
  ...(inbox.pendingApprovals.length > 0
    ? inbox.pendingApprovals.flatMap(approvalLines)
    : ["  no pending manual approval gates"]),
  "",
  "Autopilot History",
  ...(inbox.recentAutopilotApprovals.length > 0
    ? inbox.recentAutopilotApprovals.flatMap(autopilotApprovalLines)
    : ["  no recent autopilot approvals"]),
  "",
  "Agent Handoffs",
  ...(inbox.recentHandoffs.length > 0
    ? inbox.recentHandoffs.flatMap(handoffLines)
    : ["  no recent handoffs"])
].join("\n");

const automationLines = (input: DashboardInput): string[] => {
  const mode = input.approvalPolicy.mode;
  const posture =
    mode === "autopilot"
      ? "runtime may auto-approve bounded gates"
      : mode === "auto_low_risk"
        ? "bounded low-risk transfers can auto-approve"
        : "manual approval required";

  return [
    "Automation",
    `  Mode        ${modeLabel(mode)}`,
    `  Posture     ${posture}`,
    `  Transfers   ${modeLabel(input.approvalPolicy.externalTransfers.mode)} up to ${input.approvalPolicy.externalTransfers.maxAutoApproveBytes} bytes`,
    "  Hard stops  secret-risk transfers, protected test changes, destructive/dependency/network commands",
    `  Configure   thehood approvals policy set mode autopilot --repo ${quoteArg(input.repoPath)}`
  ];
};

export const renderDashboard = (input: DashboardInput): string => {
  const actions = nextActions(input.browser);
  const activeRuns = input.runMonitor.filter((run) => !["completed", "failed", "aborted"].includes(run.phase));

  return [
    renderHeader(),
    "",
    "Overview",
    `  Repo        ${input.repoPath}`,
    `  Runtime     ${input.health.runtime.name} ${input.health.runtime.version}`,
    `  Browser     ${statusWord(input.browser.readyForBridge)}`,
    `  Automation  ${modeLabel(input.approvalPolicy.mode)}`,
    `  Runs        ${activeRuns.length} active / ${input.runMonitor.length} shown`,
    "",
    ...automationLines(input),
    "",
    "ChatGPT Web",
    `  CDP         ${input.browser.cdpReachable ? "reachable" : "unreachable"} (${input.browser.cdpUrl})`,
    `  Profile     ${input.browser.profilePath}`,
    `  Tab         ${input.browser.chatGptTabFound ? "found" : "not found"}`,
    `  Provider    ${providerState(input.health, "chatgpt-web")}`,
    "",
    "Roles",
    ...roleLines(input.health),
    "",
    "Run Monitor",
    ...(input.runMonitor.length > 0
      ? input.runMonitor.flatMap(runMonitorLines)
      : ["  no runs found"]),
    "",
    renderApprovalInbox(input.approvalInbox),
    "",
    "Next Actions",
    ...(actions.length > 0 ? actions.map((action) => `  > ${action}`) : ["  > no immediate action"])
  ].join("\n");
};
