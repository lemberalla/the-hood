import { formatRoleAssignment } from "../runtime/role-assignment.js";
import type {
  ApprovalInboxHandoff,
  ApprovalInboxView,
  AutopilotApproval,
  PendingApproval
} from "../runtime/approvalInbox.js";
import type { BrowserStatus } from "../runtime/browserManager.js";
import type { RuntimeHealthReport } from "../runtime/doctor.js";
import type { ApprovalPolicy } from "../runtime/types.js";

export interface DashboardInput {
  repoPath: string;
  health: RuntimeHealthReport;
  browser: BrowserStatus;
  approvalPolicy: ApprovalPolicy;
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

  if (browser.readyForBridge) {
    actions.push("thehood doctor --repo <repo>");
    actions.push("thehood plan \"...\" --orchestrator chatgpt-web:chatgpt-pro");
  }

  return actions;
};

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;

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

  return [
    renderHeader(),
    "",
    "Overview",
    `  Repo        ${input.repoPath}`,
    `  Runtime     ${input.health.runtime.name} ${input.health.runtime.version}`,
    `  Browser     ${statusWord(input.browser.readyForBridge)}`,
    `  Automation  ${modeLabel(input.approvalPolicy.mode)}`,
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
    renderApprovalInbox(input.approvalInbox),
    "",
    "Next Actions",
    ...(actions.length > 0 ? actions.map((action) => `  > ${action}`) : ["  > no immediate action"])
  ].join("\n");
};
