import path from "node:path";

import type {
  ApprovalInboxHandoff,
  ApprovalInboxView,
  AutopilotApproval,
  PendingApproval
} from "../runtime/approvalInbox.js";
import type { BrowserStatus } from "../runtime/browserManager.js";
import type { RuntimeHealthReport } from "../runtime/doctor.js";
import type { ProviderDescriptor } from "../runtime/providers.js";
import type { RoleRosterItem } from "../runtime/roleRoster.js";
import type { RunMonitorItem } from "../runtime/runMonitor.js";
import type { TeamPreset } from "../runtime/teamPresets.js";
import type {
  ApprovalPolicy,
  LoopResponsibilityStatus,
  ReviewLaneState,
  RoleAssignment,
  TheHoodConfig
} from "../runtime/types.js";

export interface DashboardInput {
  repoPath: string;
  health: RuntimeHealthReport;
  roleRoster: RoleRosterItem[];
  browser: BrowserStatus;
  approvalPolicy: ApprovalPolicy;
  runMonitor: RunMonitorItem[];
  approvalInbox: ApprovalInboxView;
}

export interface SettingsInput {
  repoPath: string;
  configPath: string;
  config: TheHoodConfig;
  health: RuntimeHealthReport;
  roleRoster: RoleRosterItem[];
  providers: ProviderDescriptor[];
  teamPresets: TeamPreset[];
  browser: BrowserStatus;
}

interface RenderOptions {
  width?: number;
  color?: boolean;
}

export const settingsPageIds = [
  "overview",
  "crew",
  "providers",
  "budgets",
  "safety",
  "browser",
  "commands",
  "all"
] as const;

export type SettingsPageId = typeof settingsPageIds[number];

export interface SettingsRenderOptions extends RenderOptions {
  page?: SettingsPageId;
}

type Tone = "amber" | "amberDim" | "cyan" | "green" | "red" | "purple" | "muted" | "bold";

interface DashboardView {
  input: DashboardInput;
  prioritizedRuns: RunMonitorItem[];
  currentRun: RunMonitorItem | undefined;
  readyCrew: number;
  totalCrew: number;
  pendingCheckpoints: number;
  nextAction: string;
}

const ansi: Record<Tone | "reset", string> = {
  amber: "\x1b[1;38;5;214m",
  amberDim: "\x1b[38;5;178m",
  cyan: "\x1b[38;5;81m",
  green: "\x1b[38;5;82m",
  red: "\x1b[1;38;5;203m",
  purple: "\x1b[38;5;141m",
  muted: "\x1b[90m",
  bold: "\x1b[1m",
  reset: "\x1b[0m"
};

const wideMasthead = [
  "████████╗██╗  ██╗███████╗    ██╗  ██╗ ██████╗  ██████╗ ██████╗",
  "╚══██╔══╝██║  ██║██╔════╝    ██║  ██║██╔═══██╗██╔═══██╗██╔══██╗",
  "   ██║   ███████║█████╗      ███████║██║   ██║██║   ██║██║  ██║",
  "   ██║   ██╔══██║██╔══╝      ██╔══██║██║   ██║██║   ██║██║  ██║",
  "   ██║   ██║  ██║███████╗    ██║  ██║╚██████╔╝╚██████╔╝██████╔╝",
  "   ╚═╝   ╚═╝  ╚═╝╚══════╝    ╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═════╝"
];

const compactMasthead = [
  " _______ _          _   _                 _ ",
  "|__   __| |        | | | |               | |",
  "   | |  | |__   ___| |_| | ___   ___   __| |",
  "   | |  | '_ \\ / _ \\  _  |/ _ \\ / _ \\ / _` |",
  "   | |  | | | |  __/ | | | (_) | (_) | (_| |",
  "   |_|  |_| |_|\\___|_| |_|\\___/ \\___/ \\__,_|"
];

const markLines = [
  "      .-''''-.",
  "    .'  TH  '.",
  "   /  [====]  \\",
  "   |  | ██ |  |",
  "   \\  '----'  /",
  "    '. crew .'",
  "      '-..-'"
];

const terminalWidth = (): number => process.stdout.columns ?? 80;

const useAnsiColor = (): boolean =>
  Boolean(process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb");

const normalizeWidth = (width: number): number => Math.max(72, Math.min(width, 132));

const textLength = (value: string): number => Array.from(value).length;

const style = (value: string, tone: Tone, useColor: boolean): string =>
  useColor ? `${ansi[tone]}${value}${ansi.reset}` : value;

const modeLabel = (value: string): string => value.replace(/_/g, "-");

const phaseLabel = (phase: RunMonitorItem["phase"]): string =>
  phase.replace(/_/g, " ");

const laneStateLabel = (state: ReviewLaneState): string =>
  state.replace(/_/g, " ");

const loopResponsibilityStatusLabel = (status: LoopResponsibilityStatus): string =>
  status.replace(/_/g, " ");

const quoteArg = (value: string): string =>
  /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

const padEndText = (value: string, width: number): string =>
  `${value}${" ".repeat(Math.max(0, width - textLength(value)))}`;

const truncateEnd = (value: string, maxLength: number): string => {
  if (maxLength <= 0) {
    return "";
  }

  return textLength(value) <= maxLength
    ? value
    : `${Array.from(value).slice(0, Math.max(0, maxLength - 3)).join("")}...`;
};

const truncateMiddle = (value: string, maxLength: number): string => {
  const chars = Array.from(value);
  if (chars.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return ".".repeat(maxLength);
  }

  const left = Math.ceil((maxLength - 3) / 2);
  const right = Math.floor((maxLength - 3) / 2);
  return `${chars.slice(0, left).join("")}...${chars.slice(chars.length - right).join("")}`;
};

const centered = (value: string, width: number): string => {
  const remaining = Math.max(0, width - textLength(value));
  const left = Math.floor(remaining / 2);
  return `${" ".repeat(left)}${value}${" ".repeat(remaining - left)}`;
};

const frame = (
  title: string,
  lines: string[],
  width: number,
  useColor: boolean,
  tone: Tone = "amberDim"
): string => {
  const safeTitle = truncateEnd(title, Math.max(0, width - 8));
  const topFill = "─".repeat(Math.max(0, width - textLength(safeTitle) - 5));
  const top = `╭─ ${safeTitle} ${topFill}╮`;
  const bottom = `╰${"─".repeat(Math.max(0, width - 2))}╯`;
  const innerWidth = Math.max(0, width - 4);
  const body = lines.map((line) => {
    const content = truncateEnd(line, innerWidth);
    return `│ ${padEndText(content, innerWidth)} │`;
  });

  return [
    style(top, tone, useColor),
    ...body,
    style(bottom, tone, useColor)
  ].join("\n");
};

const tableRow = (columns: Array<[string, number]>): string =>
  columns.map(([value, width]) => padEndText(truncateEnd(value, width), width)).join("  ").trimEnd();

const shortRunId = (runId: string): string =>
  runId.startsWith("run_") ? `run_${runId.slice(4, 12)}` : truncateEnd(runId, 12);

const localTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
};

const providerState = (health: RuntimeHealthReport, providerId: string): string => {
  const provider = health.providers.find((candidate) => candidate.id === providerId);
  if (!provider) {
    return "not configured";
  }

  return provider.issues.length === 0 ? "ready" : provider.issues.join(", ");
};

const assignmentValue = (assignment: RoleAssignment | undefined): string =>
  assignment ? `${assignment.provider}:${assignment.model}` : "unassigned";

const repoArgs = (repoPath: string): string[] =>
  repoPath === "." || repoPath === process.cwd() ? [] : ["--repo", quoteArg(repoPath)];

const cliCommandPrefix = (): string[] => {
  const entry = process.argv[1];
  if (!entry) {
    return ["thehood"];
  }

  if (path.basename(entry) === "thehood") {
    return ["thehood"];
  }

  const absoluteEntry = path.isAbsolute(entry) ? entry : path.resolve(process.cwd(), entry);
  const relativeEntry = path.relative(process.cwd(), absoluteEntry);
  const displayEntry = relativeEntry && !relativeEntry.startsWith("..") && !path.isAbsolute(relativeEntry)
    ? relativeEntry.startsWith(".") ? relativeEntry : `.${path.sep}${relativeEntry}`
    : absoluteEntry;

  return [quoteArg(displayEntry)];
};

const cliCommand = (repoPath: string, args: string[]): string =>
  [...cliCommandPrefix(), ...args, ...repoArgs(repoPath)].join(" ");

const roleSetCommand = (repoPath: string, role: string, assignment: RoleAssignment | undefined): string =>
  cliCommand(repoPath, ["roles", "set", role, assignment ? assignmentValue(assignment) : "<provider:model>"]);

const teamApplyCommand = (repoPath: string, presetId: string): string =>
  cliCommand(repoPath, ["teams", "apply", presetId]);

const configSetCommand = (repoPath: string, key: string, value: string | number): string =>
  cliCommand(repoPath, ["config", "set", key, String(value)]);

const approvalModeCommand = (repoPath: string, mode: string): string =>
  cliCommand(repoPath, ["approvals", "policy", "set", "mode", mode]);

const externalTransferModeCommand = (repoPath: string, mode: string): string =>
  cliCommand(repoPath, ["approvals", "policy", "set", "external-transfers", mode]);

const browserCommand = (subcommand: string): string =>
  [...cliCommandPrefix(), "browser", subcommand].join(" ");

const settingsCommandGroups = {
  corePages: ["crew", "providers", "budgets", "safety", "browser", "commands"] as const
};

type CoreSettingsPageId = typeof settingsCommandGroups.corePages[number];

const statusWord = (ready: boolean): string => ready ? "ready" : "needs attention";

const roleAlias = (role: RoleRosterItem["role"]): string => {
  switch (role) {
    case "orchestrator":
      return "ORCHESTRATOR";
    case "planner":
      return "PLANNER";
    case "researcher":
      return "RESEARCHER";
    case "implementer":
      return "IMPLEMENTER";
    case "qa":
      return "QA";
    case "verifier":
      return "VERIFIER";
    case "critic":
      return "CRITIC";
    case "integrator":
      return "INTEGRATOR";
    case "citation":
      return "CITATION";
  }
};

const roleFlavor = (role: RoleRosterItem["role"]): string => {
  switch (role) {
    case "orchestrator":
      return "shot caller";
    case "implementer":
      return "builder";
    case "qa":
      return "tester";
    case "verifier":
      return "closer";
    case "critic":
      return "challenger";
    case "planner":
      return "planner";
    case "researcher":
      return "scout";
    case "integrator":
      return "runtime keys";
    case "citation":
      return "receipts";
  }
};

const rosterState = (item: RoleRosterItem): string =>
  item.issues.length > 0 ? item.issues.join(", ") : item.state;

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

const phaseRank = (run: RunMonitorItem): number => {
  switch (run.phase) {
    case "approval_gate":
      return 0;
    case "transfer_gate":
      return 1;
    case "provider_wait":
      return 2;
    case "running":
      return 3;
    case "failed":
      return 4;
    case "completed":
      return 5;
    case "aborted":
      return 6;
  }
};

const prioritizeRuns = (runs: RunMonitorItem[]): RunMonitorItem[] =>
  [...runs].sort((left, right) => {
    const rank = phaseRank(left) - phaseRank(right);
    if (rank !== 0) {
      return rank;
    }

    return right.updatedAt.localeCompare(left.updatedAt);
  });

const primaryNextAction = (input: DashboardInput, currentRun?: RunMonitorItem): string => {
  const runAction = currentRun?.operatorNextActions[0];
  if (runAction?.commandHint) {
    return runAction.commandHint;
  }

  if (runAction?.label) {
    return runAction.label;
  }

  return nextActions(input.browser)[0] ?? "no immediate action";
};

const buildView = (input: DashboardInput): DashboardView => {
  const prioritizedRuns = prioritizeRuns(input.runMonitor);
  const currentRun = prioritizedRuns[0];
  const readyCrew = input.roleRoster.filter((role) => rosterState(role) === "ready").length;

  return {
    input,
    prioritizedRuns,
    currentRun,
    readyCrew,
    totalCrew: input.roleRoster.length,
    pendingCheckpoints: input.approvalInbox.pendingApprovals.length,
    nextAction: primaryNextAction(input, currentRun)
  };
};

const renderMasthead = (width: number, useColor: boolean): string => {
  const lines = width >= 90 ? wideMasthead : compactMasthead;
  const subtitle = width >= 90
    ? "repo = neighborhood  •  agents = crew  •  runs = jobs  •  approvals = checkpoints  •  verifier = closer"
    : "repo=neighborhood  •  agents=crew  •  runs=jobs  •  approvals=checkpoints";
  const body = [
    "",
    ...lines.map((line) => centered(line, width - 4)),
    "",
    centered(truncateEnd(subtitle, width - 4), width - 4)
  ];

  return style(frame("THEHOOD", body, width, false, "amber"), "amber", useColor);
};

export const renderHeader = (width = terminalWidth()): string =>
  renderMasthead(normalizeWidth(width), useAnsiColor());

const activeJobLines = (view: DashboardView, width: number): string[] => {
  const run = view.currentRun;
  const input = view.input;
  const approvalState = view.pendingCheckpoints > 0 ? `${view.pendingCheckpoints} pending` : "clear";

  if (!run) {
    return [
      "ACTIVE JOB",
      "no jobs found",
      `repo ${truncateMiddle(input.repoPath, width - 5)}`,
      `runtime ${input.health.runtime.name} ${input.health.runtime.version}`,
      `browser ${statusWord(input.browser.readyForBridge)}`,
      `next ${truncateEnd(view.nextAction, width - 5)}`
    ];
  }

  return [
    "ACTIVE JOB",
    `${shortRunId(run.runId)}  ${run.state} / ${run.mode}`,
    `phase ${phaseLabel(run.phase)}  checkpoints ${approvalState}`,
    `repo ${truncateMiddle(input.repoPath, width - 5)}`,
    `signal ${truncateEnd(run.detail, width - 7)}`,
    `next ${truncateEnd(view.nextAction, width - 5)}`
  ];
};

const crewLines = (input: DashboardInput, width: number): string[] => {
  const primaryRoles = ["orchestrator", "implementer", "qa", "verifier", "critic"] as const;
  const roles = primaryRoles
    .map((role) => input.roleRoster.find((item) => item.role === role))
    .filter((item): item is RoleRosterItem => Boolean(item));
  const guests = roles
    .filter((role) => role.assignment && role.assignment.provider !== "codex-cli")
    .map((role) => `${roleAlias(role.role)}:${role.assignmentLabel}`);
  const roleWidth = 13;
  const flavorWidth = 11;
  const assignmentWidth = Math.max(8, width - roleWidth - flavorWidth - 4);

  return [
    "CREW + CAPABILITIES",
    ...roles.map((role) =>
      tableRow([
        [roleAlias(role.role), roleWidth],
        [truncateEnd(role.assignmentLabel, assignmentWidth), assignmentWidth],
        [truncateEnd(roleFlavor(role.role), flavorWidth), flavorWidth]
      ])
    ),
    tableRow([
      ["GUESTS", roleWidth],
      [guests.length > 0 ? truncateEnd(guests.join(", "), assignmentWidth) : "none active", assignmentWidth],
      ["runtime", flavorWidth]
    ])
  ];
};

const markColumnLines = (input: DashboardInput, width: number): string[] => [
  "MARK / BLOCK",
  ...markLines,
  `runtime ${truncateEnd(`${input.health.runtime.name} ${input.health.runtime.version}`, width - 8)}`,
  `browser ${statusWord(input.browser.readyForBridge)}`
];

const equalizeColumns = (columns: string[][]): string[][] => {
  const height = Math.max(...columns.map((column) => column.length));
  return columns.map((column) => [
    ...column,
    ...Array.from({ length: Math.max(0, height - column.length) }, () => "")
  ]);
};

const joinColumns = (columns: Array<{ width: number; lines: string[] }>): string[] => {
  const equalized = equalizeColumns(columns.map((column) => column.lines));
  const height = equalized[0]?.length ?? 0;

  return Array.from({ length: height }, (_, index) =>
    columns.map((column, columnIndex) =>
      padEndText(truncateEnd(equalized[columnIndex]?.[index] ?? "", column.width), column.width)
    ).join("  ")
  );
};

const runOwner = (run: RunMonitorItem): string =>
  run.provider ?? run.lane ?? "runtime";

const runSignal = (run: RunMonitorItem): string =>
  run.operatorNextActions[0]?.label ?? run.detail;

const runMonitorRows = (runs: RunMonitorItem[], width: number, limit: number): string[] => {
  if (runs.length === 0) {
    return ["no jobs found"];
  }

  if (width < 92) {
    const signalWidth = Math.max(16, width - 36);
    return [
      tableRow([
        ["RUN", 12],
        ["STATE", 13],
        ["TIME", 5],
        ["SIGNAL", signalWidth]
      ]),
      ...runs.slice(0, limit).map((run) =>
        tableRow([
          [shortRunId(run.runId), 12],
          [phaseLabel(run.phase), 13],
          [localTime(run.updatedAt), 5],
          [truncateEnd(runSignal(run), signalWidth), signalWidth]
        ])
      )
    ];
  }

  const signalWidth = Math.max(16, width - 69);
  return [
    tableRow([
      ["PRI", 3],
      ["RUN", 12],
      ["STATE", 13],
      ["MODE", 8],
      ["OWNER", 18],
      ["TIME", 5],
      ["SIGNAL", signalWidth]
    ]),
    ...runs.slice(0, limit).map((run, index) =>
      tableRow([
        [String(index + 1).padStart(2, "0"), 3],
        [shortRunId(run.runId), 12],
        [phaseLabel(run.phase), 13],
        [run.mode, 8],
        [truncateEnd(runOwner(run), 18), 18],
        [localTime(run.updatedAt), 5],
        [truncateEnd(runSignal(run), signalWidth), signalWidth]
      ])
    )
  ];
};

const approvalCommand = (approval: PendingApproval, command: "approve" | "reject" | "revise"): string => [
  "thehood",
  "ui",
  "approvals",
  "--repo",
  quoteArg(approval.repoPath),
  `--${command}`,
  approval.runId
].join(" ");

const transferPreviewCommand = (approval: PendingApproval): string => [
  "thehood",
  "transfer",
  "preview",
  approval.runId,
  "--repo",
  quoteArg(approval.repoPath)
].join(" ");

const autopilotTransferPreviewCommand = (approval: AutopilotApproval): string => [
  "thehood",
  "transfer",
  "preview",
  approval.runId,
  "--repo",
  quoteArg(approval.repoPath)
].join(" ");

const checkpointRows = (inbox: ApprovalInboxView, width: number, limit: number): string[] => {
  if (inbox.pendingApprovals.length === 0) {
    return [
      tableRow([["CLEAR", 8], ["edit", 12], ["blocked by runtime policy", Math.max(16, width - 24)]]),
      tableRow([["CLEAR", 8], ["deps", 12], ["no dependency installs in this UI slice", Math.max(16, width - 24)]]),
      tableRow([["GATED", 8], ["network", 12], ["runtime approval policy controls external effects", Math.max(16, width - 24)]])
    ];
  }

  return inbox.pendingApprovals.slice(0, limit).flatMap((approval, index) => {
    const lines = [
      tableRow([
        [`!! ${index + 1}`, 5],
        [shortRunId(approval.runId), 12],
        [approval.state, 17],
        [truncateEnd(approval.reason, Math.max(18, width - 40)), Math.max(18, width - 40)]
      ]),
      `approve ${truncateEnd(approvalCommand(approval, "approve"), Math.max(20, width - 8))}`
    ];

    if (approval.artifacts.some((artifact) => artifact.kind === "transfer_manifest")) {
      lines.push(`preview ${truncateEnd(transferPreviewCommand(approval), Math.max(20, width - 8))}`);
    }

    return lines;
  });
};

const autopilotRows = (inbox: ApprovalInboxView, width: number, limit: number): string[] => {
  if (inbox.recentAutopilotApprovals.length === 0) {
    return ["no recent autopilot approvals"];
  }

  return [
    tableRow([["TIME", 5], ["GATE", 24], ["NOTE", Math.max(16, width - 33)]]),
    ...inbox.recentAutopilotApprovals.slice(0, limit).flatMap((approval) => {
      const lines = [
        tableRow([
          [localTime(approval.createdAt), 5],
          [truncateEnd(approval.gate ?? "autopilot", 24), 24],
          [truncateEnd(approval.policyReason ?? approval.message, Math.max(16, width - 33)), Math.max(16, width - 33)]
        ])
      ];

      if (approval.artifact?.kind === "transfer_manifest") {
        lines.push(`preview ${truncateEnd(autopilotTransferPreviewCommand(approval), Math.max(20, width - 8))}`);
      }

      return lines;
    })
  ];
};

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

const handoffRows = (inbox: ApprovalInboxView, width: number, limit: number): string[] => {
  if (inbox.recentHandoffs.length === 0) {
    return ["no recent handoffs"];
  }

  return inbox.recentHandoffs.slice(0, limit).map((handoff) =>
    tableRow([
      [truncateEnd(handoffEndpoint(handoff.fromLabel, handoff.fromAssignment, "Runtime"), 24), 24],
      ["->", 2],
      [truncateEnd(handoffDestination(handoff), 24), 24],
      [truncateEnd(handoff.gate ?? handoff.kind, Math.max(10, width - 56)), Math.max(10, width - 56)]
    ])
  );
};

const laneOwnerLabel = (lane: RunMonitorItem["reviewLanes"][number]): string =>
  lane.owner.assignment ? `${lane.owner.label} (${lane.owner.assignment})` : lane.owner.label;

const laneSatisfactionLabel = (lane: RunMonitorItem["reviewLanes"][number]): string =>
  lane.required
    ? lane.satisfiesRequired ? "satisfies" : "missing"
    : "advisory";

const reviewLaneRows = (run: RunMonitorItem | undefined, width: number): string[] => {
  if (!run || run.reviewLanes.length === 0) {
    return [
      tableRow([["safety", 12], ["verifier", 16], ["no approval weakening", Math.max(16, width - 32)]]),
      tableRow([["display", 12], ["qa", 16], ["wide and compact output stays readable", Math.max(16, width - 32)]]),
      tableRow([["regression", 12], ["critic", 16], ["static data still renders", Math.max(16, width - 32)]])
    ];
  }

  return run.reviewLanes.slice(0, 4).map((lane) =>
    tableRow([
      [lane.kind, 12],
      [truncateEnd(laneStateLabel(lane.state), 16), 16],
      [truncateEnd(`${laneSatisfactionLabel(lane)} ${laneOwnerLabel(lane)}`, Math.max(16, width - 32)), Math.max(16, width - 32)]
    ])
  );
};

const responsibilityRows = (run: RunMonitorItem | undefined, width: number): string[] => {
  if (!run || run.loopResponsibilities.length === 0) {
    return ["loop responsibilities not reported"];
  }

  return run.loopResponsibilities.slice(0, 5).map((item) =>
    tableRow([
      [item.kind, 17],
      [loopResponsibilityStatusLabel(item.status), 12],
      [truncateEnd(item.owner.assignment ?? item.owner.label, Math.max(16, width - 33)), Math.max(16, width - 33)]
    ])
  );
};

const browserLines = (input: DashboardInput, width: number): string[] => [
  "BROWSER / REMOTE SURFACE",
  `cdp ${input.browser.cdpReachable ? "reachable" : "unreachable"} ${truncateEnd(input.browser.cdpUrl, Math.max(10, width - 18))}`,
  `profile ${truncateMiddle(input.browser.profilePath, Math.max(10, width - 10))}`,
  `tab ${input.browser.chatGptTabFound ? "found" : "not found"}  provider ${truncateEnd(providerState(input.health, "chatgpt-web"), Math.max(8, width - 30))}`
];

const statusRail = (view: DashboardView, width: number, useColor: boolean): string => {
  const input = view.input;
  const rail = [
    `health ${input.health.runtime.name}`,
    `policy ${modeLabel(input.approvalPolicy.mode)}`,
    `crew ${view.readyCrew}/${view.totalCrew}`,
    `checkpoints ${view.pendingCheckpoints > 0 ? `${view.pendingCheckpoints} pending` : "clear"}`,
    `browser ${statusWord(input.browser.readyForBridge)}`,
    "refs-only"
  ].map((item) => `[${item}]`).join(" ");

  return style(truncateEnd(rail, width), view.pendingCheckpoints > 0 ? "red" : "green", useColor);
};

const promptRail = (view: DashboardView, width: number, useColor: boolean): string =>
  style(truncateEnd(`hood> next: ${view.nextAction}`, width), "amber", useColor);

const exactApprovalCommandLines = (inbox: ApprovalInboxView): string[] => {
  if (inbox.pendingApprovals.length === 0) {
    return [];
  }

  return [
    "Exact Checkpoint Commands",
    ...inbox.pendingApprovals.flatMap((approval) => [
      `  ${approval.runId}`,
      `    approve ${approvalCommand(approval, "approve")}`,
      `    reject  ${approvalCommand(approval, "reject")}`,
      `    revise  ${approvalCommand(approval, "revise")}`,
      `    resume  thehood continue ${approval.runId} --repo ${quoteArg(approval.repoPath)}`,
      ...(approval.artifacts.some((artifact) => artifact.kind === "transfer_manifest")
        ? [`    preview ${transferPreviewCommand(approval)}`]
        : [])
    ])
  ];
};

const commandCenterWide = (view: DashboardView, width: number, useColor: boolean): string => {
  const innerWidth = width - 4;
  const gapTotal = 4;
  const leftWidth = 22;
  const rightWidth = width >= 124 ? 48 : 44;
  const centerWidth = Math.max(30, innerWidth - leftWidth - rightWidth - gapTotal);
  const sideBySide = joinColumns([
    { width: leftWidth, lines: markColumnLines(view.input, leftWidth) },
    { width: centerWidth, lines: activeJobLines(view, centerWidth) },
    { width: rightWidth, lines: crewLines(view.input, rightWidth) }
  ]);
  const halfGap = 2;
  const leftPanelWidth = Math.floor((innerWidth - halfGap) / 2);
  const rightPanelWidth = innerWidth - halfGap - leftPanelWidth;
  const checkpointAndAuto = joinColumns([
    { width: leftPanelWidth, lines: ["CHECKPOINTS / APPROVAL GATES", ...checkpointRows(view.input.approvalInbox, leftPanelWidth, 3)] },
    { width: rightPanelWidth, lines: ["AUTOPILOT LEDGER", ...autopilotRows(view.input.approvalInbox, rightPanelWidth, 4)] }
  ]);
  const handoffAndReview = joinColumns([
    { width: leftPanelWidth, lines: ["HANDOFFS", ...handoffRows(view.input.approvalInbox, leftPanelWidth, 4)] },
    { width: rightPanelWidth, lines: ["REVIEW LANES", ...reviewLaneRows(view.currentRun, rightPanelWidth)] }
  ]);
  const lines = [
    ...sideBySide,
    "",
    "RUN MONITOR / JOB BOARD",
    ...runMonitorRows(view.prioritizedRuns, innerWidth, 5),
    "",
    ...checkpointAndAuto,
    "",
    ...handoffAndReview,
    "",
    "LOOP RESPONSIBILITIES",
    ...responsibilityRows(view.currentRun, innerWidth)
  ];

  return frame(`THEHOOD COMMAND CENTER  mode: ${view.currentRun?.mode.toUpperCase() ?? "IDLE"}`, lines, width, useColor, "amber");
};

const commandCenterCompact = (view: DashboardView, width: number, useColor: boolean): string => {
  const innerWidth = width - 4;
  const crew = crewLines(view.input, innerWidth).slice(1);
  const lines = [
    "MARK        ACTIVE JOB",
    tableRow([[".-TH-.", 12], [view.currentRun ? `${shortRunId(view.currentRun.runId)}  ${view.currentRun.state} / ${view.currentRun.mode}` : "no active job", innerWidth - 14]]),
    tableRow([["(crew)", 12], [`checkpoints ${view.pendingCheckpoints > 0 ? `${view.pendingCheckpoints} pending` : "clear"}  autopilot ${modeLabel(view.input.approvalPolicy.mode)}`, innerWidth - 14]]),
    tableRow([["`---'", 12], [`repo ${truncateMiddle(view.input.repoPath, innerWidth - 19)}`, innerWidth - 14]]),
    tableRow([["", 12], [`next ${truncateEnd(view.nextAction, innerWidth - 19)}`, innerWidth - 14]]),
    "",
    "CREW",
    ...crew.slice(0, 5),
    "",
    "BROWSER / REMOTE SURFACE",
    ...browserLines(view.input, innerWidth).slice(1),
    "",
    "JOB BOARD",
    ...runMonitorRows(view.prioritizedRuns, innerWidth, 4),
    "",
    "CHECKPOINTS / APPROVAL GATES",
    ...checkpointRows(view.input.approvalInbox, innerWidth, 2),
    "",
    "AUTOPILOT LEDGER",
    ...autopilotRows(view.input.approvalInbox, innerWidth, 3),
    "",
    "HANDOFFS",
    ...handoffRows(view.input.approvalInbox, innerWidth, 3),
    "",
    "REVIEW LANES",
    ...reviewLaneRows(view.currentRun, innerWidth)
  ];

  return frame(`THEHOOD COMMAND CENTER  mode: ${view.currentRun?.mode.toUpperCase() ?? "IDLE"}`, lines, width, useColor, "amber");
};

const teamPresetIsActive = (input: SettingsInput, preset: TeamPreset): boolean =>
  Object.entries(preset.roles).every(([role, assignment]) =>
    assignmentValue(input.config.roles[role as keyof typeof input.config.roles]) === assignmentValue(assignment)
  );

const settingsOverviewLines = (input: SettingsInput, width: number): string[] => [
  "HOOD PROFILE",
  `repo ${truncateMiddle(input.repoPath, width - 5)}`,
  `config ${truncateMiddle(input.configPath, width - 8)}`,
  `version ${input.config.version}`,
  `runtime ${input.health.runtime.name} ${input.health.runtime.version}`,
  `browser ${statusWord(input.browser.readyForBridge)}`
];

const settingsCrewRows = (input: SettingsInput, width: number): string[] => {
  const commandWidth = Math.max(24, width - 45);

  return [
    tableRow([
      ["ROLE", 12],
      ["ASSIGNMENT", 18],
      ["STATE", 9],
      ["COMMAND", commandWidth]
    ]),
    ...input.roleRoster.map((role) =>
      tableRow([
        [role.role, 12],
        [truncateEnd(assignmentValue(role.assignment), 18), 18],
        [truncateEnd(rosterState(role), 9), 9],
        [truncateEnd(roleSetCommand(input.repoPath, role.role, role.assignment), commandWidth), commandWidth]
      ])
    )
  ];
};

const settingsTeamRows = (input: SettingsInput, width: number): string[] => {
  const commandWidth = Math.max(24, width - 40);

  return [
    tableRow([
      ["ON", 4],
      ["PRESET", 16],
      ["SUMMARY", 14],
      ["COMMAND", commandWidth]
    ]),
    ...input.teamPresets.map((preset) =>
      tableRow([
        [teamPresetIsActive(input, preset) ? "yes" : "", 4],
        [preset.id, 16],
        [truncateEnd(preset.summary, 14), 14],
        [truncateEnd(teamApplyCommand(input.repoPath, preset.id), commandWidth), commandWidth]
      ])
    )
  ];
};

const settingsBudgetLines = (input: SettingsInput, width: number): string[] => [
  tableRow([
    ["SETTING", 18],
    ["VALUE", 7],
    ["COMMAND", Math.max(24, width - 29)]
  ]),
  tableRow([
    ["max iterations", 18],
    [String(input.config.defaults.maxIterations), 7],
    [truncateEnd(configSetCommand(input.repoPath, "max-iterations", input.config.defaults.maxIterations), Math.max(24, width - 29)), Math.max(24, width - 29)]
  ]),
  tableRow([
    ["fanout max items", 18],
    [String(input.config.defaults.fanoutMaxItems), 7],
    [truncateEnd(configSetCommand(input.repoPath, "fanout-max-items", input.config.defaults.fanoutMaxItems), Math.max(24, width - 29)), Math.max(24, width - 29)]
  ])
];

const settingsApprovalLines = (input: SettingsInput, width: number): string[] => {
  const commandWidth = Math.max(24, width - 29);

  return [
    tableRow([["MODE", 18], ["VALUE", 7], ["COMMAND", commandWidth]]),
    tableRow([
      ["approval posture", 18],
      [modeLabel(input.config.approvalPolicy.mode), 7],
      [truncateEnd(approvalModeCommand(input.repoPath, modeLabel(input.config.approvalPolicy.mode)), commandWidth), commandWidth]
    ]),
    tableRow([
      ["external transfers", 18],
      [modeLabel(input.config.approvalPolicy.externalTransfers.mode), 7],
      [truncateEnd(externalTransferModeCommand(input.repoPath, modeLabel(input.config.approvalPolicy.externalTransfers.mode)), commandWidth), commandWidth]
    ]),
    tableRow([
      ["max auto bytes", 18],
      [String(input.config.approvalPolicy.externalTransfers.maxAutoApproveBytes), 7],
      [truncateEnd("edit .thehood/config.json approvalPolicy.externalTransfers.maxAutoApproveBytes", commandWidth), commandWidth]
    ]),
    tableRow([
      ["transfer rules", 18],
      [String(input.config.approvalPolicy.externalTransfers.rules.length), 7],
      [truncateEnd("edit .thehood/config.json approvalPolicy.externalTransfers.rules", commandWidth), commandWidth]
    ])
  ];
};

const settingsSafetyLines = (input: SettingsInput, width: number): string[] => [
  tableRow([["RAIL", 28], ["VALUE", 8], ["CONTROL", Math.max(16, width - 40)]]),
  tableRow([
    ["edit requires approval", 28],
    [String(input.config.defaults.editRequiresApproval), 8],
    [truncateEnd("edit .thehood/config.json defaults.editRequiresApproval", Math.max(16, width - 40)), Math.max(16, width - 40)]
  ]),
  tableRow([
    ["dependency install approval", 28],
    [String(input.config.defaults.dependencyInstallRequiresApproval), 8],
    [truncateEnd("edit .thehood/config.json defaults.dependencyInstallRequiresApproval", Math.max(16, width - 40)), Math.max(16, width - 40)]
  ]),
  tableRow([
    ["network requires approval", 28],
    [String(input.config.defaults.networkRequiresApproval), 8],
    [truncateEnd("edit .thehood/config.json defaults.networkRequiresApproval", Math.max(16, width - 40)), Math.max(16, width - 40)]
  ]),
  tableRow([
    ["protected test paths", 28],
    [String(input.config.defaults.protectedTestPaths.length), 8],
    [truncateEnd(input.config.defaults.protectedTestPaths.join(", "), Math.max(16, width - 40)), Math.max(16, width - 40)]
  ])
];

const settingsProviderRows = (input: SettingsInput, width: number): string[] => {
  const modelsWidth = Math.max(14, width - 58);

  return [
    tableRow([
      ["PROVIDER", 16],
      ["STATE", 9],
      ["MODE", 13],
      ["HEALTH", 12],
      ["MODELS", modelsWidth]
    ]),
    ...input.providers.map((provider) =>
      tableRow([
        [provider.id, 16],
        [provider.enabled ? "enabled" : "disabled", 9],
        [provider.defaultAccessMode, 13],
        [truncateEnd(providerState(input.health, provider.id), 12), 12],
        [truncateEnd(provider.models.join(", "), modelsWidth), modelsWidth]
      ])
    )
  ];
};

const settingsBrowserLines = (input: SettingsInput, width: number): string[] => [
  `cdp ${input.browser.cdpReachable ? "reachable" : "unreachable"} ${truncateEnd(input.browser.cdpUrl, Math.max(10, width - 18))}`,
  `profile ${truncateMiddle(input.browser.profilePath, Math.max(10, width - 10))}`,
  `tab ${input.browser.chatGptTabFound ? "found" : "not found"}`,
  `start ${truncateEnd(browserCommand("start"), Math.max(10, width - 7))}`,
  `status ${truncateEnd(browserCommand("status"), Math.max(10, width - 8))}`,
  `stop ${truncateEnd(browserCommand("stop"), Math.max(10, width - 6))}`
];

const settingsActionDeckLines = (input: SettingsInput, width: number): string[] => [
  "Source-Of-Truth Commands",
  "  Safety",
  `    ${approvalModeCommand(input.repoPath, "manual")}`,
  `    ${approvalModeCommand(input.repoPath, "auto-low-risk")}`,
  `    ${approvalModeCommand(input.repoPath, "autopilot")}`,
  `    ${externalTransferModeCommand(input.repoPath, "manual")}`,
  `    ${externalTransferModeCommand(input.repoPath, "auto-low-risk")}`,
  "  Budgets",
  `    ${configSetCommand(input.repoPath, "max-iterations", input.config.defaults.maxIterations)}`,
  `    ${configSetCommand(input.repoPath, "fanout-max-items", input.config.defaults.fanoutMaxItems)}`,
  "  Team",
  ...input.teamPresets.map((preset) => `    ${teamApplyCommand(input.repoPath, preset.id)}`),
  "  Browser",
  `    ${browserCommand("status")}`,
  `    ${browserCommand("start")}`,
  `    ${browserCommand("stop")}`,
  "",
  "Current Crew",
  ...input.roleRoster.map((role) => `  ${truncateEnd(roleSetCommand(input.repoPath, role.role, role.assignment), width - 2)}`)
];

const settingsUnderlyingCommandLines = (input: SettingsInput, width: number): string[] => [
  "Underlying Commands",
  `  ${approvalModeCommand(input.repoPath, "manual")}`,
  `  ${approvalModeCommand(input.repoPath, "auto-low-risk")}`,
  `  ${approvalModeCommand(input.repoPath, "autopilot")}`,
  `  ${configSetCommand(input.repoPath, "max-iterations", input.config.defaults.maxIterations)}`,
  `  ${configSetCommand(input.repoPath, "fanout-max-items", input.config.defaults.fanoutMaxItems)}`,
  `  ${externalTransferModeCommand(input.repoPath, "manual")}`,
  `  ${externalTransferModeCommand(input.repoPath, "auto-low-risk")}`,
  `  ${browserCommand("status")}`,
  `  ${browserCommand("start")}`,
  `  ${browserCommand("stop")}`,
  `  ${cliCommand(input.repoPath, ["teams"])}`,
  `  ${cliCommand(input.repoPath, ["providers"])}`,
  `  ${cliCommand(input.repoPath, ["roster"])}`,
  "",
  "Crew Role Commands",
  ...input.roleRoster.map((role) => `  ${roleSetCommand(input.repoPath, role.role, role.assignment)}`),
  "",
  "Editable In Config",
  `  ${truncateMiddle(input.configPath, width - 4)}`,
  "  approvalPolicy.externalTransfers.maxAutoApproveBytes",
  "  approvalPolicy.externalTransfers.rules",
  "  defaults.editRequiresApproval",
  "  defaults.dependencyInstallRequiresApproval",
  "  defaults.networkRequiresApproval",
  "  defaults.protectedTestPaths",
  "  providers.<id>"
];

const settingsCommandDeckLines = (input: SettingsInput, width: number): string[] => [
  ...settingsActionDeckLines(input, width),
  "",
  ...settingsUnderlyingCommandLines(input, width)
];

const settingsPageDescription: Record<SettingsPageId, string> = {
  overview: "compact status and page menu",
  crew: "role assignments and set commands",
  providers: "provider states and available models",
  budgets: "iteration and fan-out limits",
  safety: "approval policy and protected rails",
  browser: "ChatGPT Web bridge status",
  commands: "exact CLI commands and config keys",
  all: "full settings cockpit"
};

const settingsPageCommand = (input: SettingsInput, page: SettingsPageId): string =>
  page === "overview"
    ? cliCommand(input.repoPath, ["ui", "settings"])
    : cliCommand(input.repoPath, ["ui", "settings", page]);

const settingsSummaryLines = (input: SettingsInput, width: number): string[] => {
  const readyCrew = input.roleRoster.filter((role) => rosterState(role) === "ready").length;
  const enabledProviders = input.providers.filter((provider) => provider.enabled).length;
  const readyProviders = input.providers.filter((provider) => provider.enabled && providerState(input.health, provider.id) === "ready").length;

  return [
    ...settingsOverviewLines(input, width),
    `policy ${modeLabel(input.config.approvalPolicy.mode)}  transfers ${modeLabel(input.config.approvalPolicy.externalTransfers.mode)}`,
    `crew ${readyCrew}/${input.roleRoster.length} ready  providers ${readyProviders}/${enabledProviders} ready`,
    `budgets max iterations ${input.config.defaults.maxIterations}  fanout ${input.config.defaults.fanoutMaxItems}`,
    `hard stops protected tests, secret-risk transfers, destructive/dependency/network commands`
  ];
};

const settingsCrewSnapshotLines = (input: SettingsInput, width: number): string[] => {
  const primaryRoles = ["orchestrator", "implementer", "qa", "verifier", "critic"] as const;
  const roles = primaryRoles
    .map((role) => input.roleRoster.find((item) => item.role === role))
    .filter((item): item is RoleRosterItem => Boolean(item));
  const assignmentWidth = Math.max(12, width - 31);

  return [
    tableRow([["ROLE", 14], ["ASSIGNMENT", assignmentWidth], ["STATE", 13]]),
    ...roles.map((role) =>
      tableRow([
        [role.role, 14],
        [truncateEnd(assignmentValue(role.assignment), assignmentWidth), assignmentWidth],
        [truncateEnd(rosterState(role), 13), 13]
      ])
    )
  ];
};

const settingsPageMenuLines = (input: SettingsInput, width: number): string[] => {
  const pages: CoreSettingsPageId[] = [...settingsCommandGroups.corePages];
  const descriptionWidth = width >= 96 ? 34 : 24;
  const commandWidth = Math.max(16, width - descriptionWidth - 14);

  return [
    tableRow([["PAGE", 10], ["WHAT", descriptionWidth], ["COMMAND", commandWidth]]),
    ...pages.map((page) =>
      tableRow([
        [page, 10],
        [truncateEnd(settingsPageDescription[page], descriptionWidth), descriptionWidth],
        [truncateEnd(settingsPageCommand(input, page), commandWidth), commandWidth]
      ])
    )
  ];
};

const renderSettingsOverview = (input: SettingsInput, width: number, useColor: boolean): string => {
  const innerWidth = width - 4;
  const lines = [
    ...settingsSummaryLines(input, innerWidth),
    "",
    "CREW SNAPSHOT",
    ...settingsCrewSnapshotLines(input, innerWidth),
    "",
    "OPEN A SETTINGS PAGE",
    ...settingsPageMenuLines(input, innerWidth)
  ];

  return frame("THEHOOD SETTINGS COCKPIT", lines, width, useColor, "amber");
};

const renderSettingsCrew = (input: SettingsInput, width: number, useColor: boolean): string => {
  const innerWidth = width - 4;
  const lines = [
    "CREW ASSIGNMENTS",
    ...settingsCrewRows(input, innerWidth)
  ];

  return frame("THEHOOD SETTINGS / CREW", lines, width, useColor, "amber");
};

const renderSettingsProviders = (input: SettingsInput, width: number, useColor: boolean): string => {
  const innerWidth = width - 4;
  const lines = [
    "PROVIDER BAY",
    ...settingsProviderRows(input, innerWidth)
  ];

  return frame("THEHOOD SETTINGS / PROVIDERS", lines, width, useColor, "amber");
};

const renderSettingsBudgets = (input: SettingsInput, width: number, useColor: boolean): string => {
  const innerWidth = width - 4;
  const lines = [
    "BUDGETS",
    ...settingsBudgetLines(input, innerWidth)
  ];

  return frame("THEHOOD SETTINGS / BUDGETS", lines, width, useColor, "amber");
};

const renderSettingsSafety = (input: SettingsInput, width: number, useColor: boolean): string => {
  const innerWidth = width - 4;
  const lines = [
    "AUTOPILOT / TRANSFERS",
    ...settingsApprovalLines(input, innerWidth),
    "",
    "SAFETY RAILS",
    ...settingsSafetyLines(input, innerWidth)
  ];

  return frame("THEHOOD SETTINGS / SAFETY", lines, width, useColor, "amber");
};

const renderSettingsBrowser = (input: SettingsInput, width: number, useColor: boolean): string => {
  const innerWidth = width - 4;
  const lines = [
    "BROWSER BRIDGE",
    ...settingsBrowserLines(input, innerWidth)
  ];

  return frame("THEHOOD SETTINGS / BROWSER", lines, width, useColor, "amber");
};

const renderSettingsCommands = (input: SettingsInput, width: number, useColor: boolean): string => {
  const innerWidth = width - 4;

  return frame(
    "THEHOOD SETTINGS / COMMANDS",
    settingsCommandDeckLines(input, innerWidth),
    width,
    useColor,
    "amber"
  );
};

const settingsWide = (input: SettingsInput, width: number, useColor: boolean): string => {
  const innerWidth = width - 4;
  const gap = 2;
  const halfWidth = Math.floor((innerWidth - gap) / 2);
  const rightWidth = innerWidth - gap - halfWidth;
  const top = joinColumns([
    { width: halfWidth, lines: settingsOverviewLines(input, halfWidth) },
    { width: rightWidth, lines: ["BUDGETS", ...settingsBudgetLines(input, rightWidth)] }
  ]);
  const policy = joinColumns([
    { width: halfWidth, lines: ["AUTOPILOT / TRANSFERS", ...settingsApprovalLines(input, halfWidth)] },
    { width: rightWidth, lines: ["SAFETY RAILS", ...settingsSafetyLines(input, rightWidth)] }
  ]);
  const bridge = joinColumns([
    { width: halfWidth, lines: ["PROVIDER BAY", ...settingsProviderRows(input, halfWidth)] },
    { width: rightWidth, lines: ["BROWSER BRIDGE", ...settingsBrowserLines(input, rightWidth)] }
  ]);
  const lines = [
    ...top,
    "",
    "CREW ASSIGNMENTS",
    ...settingsCrewRows(input, innerWidth),
    "",
    ...settingsActionDeckLines(input, innerWidth),
    "",
    "TEAM PRESETS",
    ...settingsTeamRows(input, innerWidth),
    "",
    ...policy,
    "",
    ...bridge,
    "",
    ...settingsUnderlyingCommandLines(input, innerWidth)
  ];

  return frame("THEHOOD SETTINGS / ALL", lines, width, useColor, "amber");
};

const settingsCompact = (input: SettingsInput, width: number, useColor: boolean): string => {
  const innerWidth = width - 4;
  const lines = [
    ...settingsOverviewLines(input, innerWidth),
    "",
    "CREW ASSIGNMENTS",
    ...settingsCrewRows(input, innerWidth),
    "",
    ...settingsActionDeckLines(input, innerWidth),
    "",
    "TEAM PRESETS",
    ...settingsTeamRows(input, innerWidth),
    "",
    "BUDGETS",
    ...settingsBudgetLines(input, innerWidth),
    "",
    "AUTOPILOT / TRANSFERS",
    ...settingsApprovalLines(input, innerWidth),
    "",
    "SAFETY RAILS",
    ...settingsSafetyLines(input, innerWidth),
    "",
    "PROVIDER BAY",
    ...settingsProviderRows(input, innerWidth),
    "",
    "BROWSER BRIDGE",
    ...settingsBrowserLines(input, innerWidth),
    "",
    ...settingsUnderlyingCommandLines(input, innerWidth)
  ];

  return frame("THEHOOD SETTINGS / ALL", lines, width, useColor, "amber");
};

const renderSettingsPage = (
  input: SettingsInput,
  page: SettingsPageId,
  width: number,
  useColor: boolean
): string => {
  switch (page) {
    case "overview":
      return renderSettingsOverview(input, width, useColor);
    case "crew":
      return renderSettingsCrew(input, width, useColor);
    case "providers":
      return renderSettingsProviders(input, width, useColor);
    case "budgets":
      return renderSettingsBudgets(input, width, useColor);
    case "safety":
      return renderSettingsSafety(input, width, useColor);
    case "browser":
      return renderSettingsBrowser(input, width, useColor);
    case "commands":
      return renderSettingsCommands(input, width, useColor);
    case "all":
      return width >= 110 ? settingsWide(input, width, useColor) : settingsCompact(input, width, useColor);
  }
};

export const renderApprovalInbox = (
  inbox: ApprovalInboxView,
  options: RenderOptions = {}
): string => {
  const width = normalizeWidth(options.width ?? terminalWidth());
  const useColor = options.color ?? useAnsiColor();
  const pendingTitle = `CHECKPOINTS / APPROVAL GATES  pending: ${inbox.pendingApprovals.length}  auto-cleared: ${inbox.recentAutopilotApprovals.length}  handoffs: ${inbox.recentHandoffs.length}`;
  const pendingLines = [
    "runtime owns approval state; commands below act through runtime gates",
    "autopilot still stops for protected test changes, secret-risk transfers, destructive/dependency/network commands",
    "",
    ...checkpointRows(inbox, width - 4, Math.max(1, inbox.pendingApprovals.length)),
    ...(inbox.pendingApprovals.some((approval) => approval.artifacts.length > 0)
      ? [
          "",
          "RECEIPTS",
          ...inbox.pendingApprovals.flatMap((approval) =>
            approval.artifacts.map((artifact) => `${shortRunId(approval.runId)} ${artifact.kind}: ${artifact.summary}`)
          )
        ]
      : [])
  ];
  const autopilotLines = autopilotRows(inbox, width - 4, Math.max(1, inbox.recentAutopilotApprovals.length));
  const handoffLines = handoffRows(inbox, width - 4, Math.max(1, inbox.recentHandoffs.length));
  const exactCommands = exactApprovalCommandLines(inbox);

  return [
    frame(pendingTitle, pendingLines, width, useColor, "amber"),
    "",
    frame("AUTOPILOT LEDGER", autopilotLines, width, useColor, "cyan"),
    "",
    frame("HANDOFFS", handoffLines, width, useColor, "amberDim"),
    ...(exactCommands.length > 0 ? ["", ...exactCommands] : [])
  ].join("\n");
};

export const renderDashboard = (
  input: DashboardInput,
  options: RenderOptions = {}
): string => {
  const width = normalizeWidth(options.width ?? terminalWidth());
  const useColor = options.color ?? useAnsiColor();
  const view = buildView(input);
  const commandCenter = width >= 110
    ? commandCenterWide(view, width, useColor)
    : commandCenterCompact(view, width, useColor);

  return [
    renderMasthead(width, useColor),
    "",
    commandCenter,
    "",
    statusRail(view, width, useColor),
    promptRail(view, width, useColor)
  ].join("\n");
};

export const renderSettingsCockpit = (
  input: SettingsInput,
  options: SettingsRenderOptions = {}
): string => {
  const width = normalizeWidth(options.width ?? terminalWidth());
  const useColor = options.color ?? useAnsiColor();
  const page = options.page ?? "overview";
  const settings = renderSettingsPage(input, page, width, useColor);
  const backCommand = settingsPageCommand(input, "overview");

  return [
    renderMasthead(width, useColor),
    "",
    settings,
    "",
    style(
      truncateEnd(`[settings page ${page}] [source .thehood/config.json] [runtime enforces] [ui displays commands]`, width),
      "green",
      useColor
    ),
    style(
      truncateEnd(page === "overview" ? `run: ${settingsPageCommand(input, "crew")}` : `run: ${backCommand}`, width),
      "amber",
      useColor
    )
  ].join("\n");
};
