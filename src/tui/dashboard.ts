import { formatRoleAssignment } from "../runtime/role-assignment.js";
import type { PendingApproval } from "../runtime/approvalInbox.js";
import type { BrowserStatus } from "../runtime/browserManager.js";
import type { RuntimeHealthReport } from "../runtime/doctor.js";
import type { ApprovalPolicy } from "../runtime/types.js";

export interface DashboardInput {
  repoPath: string;
  health: RuntimeHealthReport;
  browser: BrowserStatus;
  approvalPolicy: ApprovalPolicy;
  pendingApprovals: PendingApproval[];
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

export const renderApprovalInbox = (approvals: PendingApproval[]): string => [
  "Approval Gates",
  ...(approvals.length > 0
    ? approvals.flatMap(approvalLines)
    : ["  no pending approval gates"])
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
    renderApprovalInbox(input.pendingApprovals),
    "",
    "Next Actions",
    ...(actions.length > 0 ? actions.map((action) => `  > ${action}`) : ["  > no immediate action"])
  ].join("\n");
};
