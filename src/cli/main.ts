#!/usr/bin/env node
import path from "node:path";
import { initConfig, loadConfig, writeConfig } from "../runtime/config.js";
import { inspectBrowser, startBrowser, stopBrowser, type BrowserManagerOptions } from "../runtime/browserManager.js";
import { runRuntimeCommand } from "../runtime/commandRunner.js";
import { buildAgentBoard } from "../runtime/agentBoard.js";
import { buildAgentBoardArtifact } from "../runtime/agentBoardArtifact.js";
import { inspectRuntimeHealth } from "../runtime/doctor.js";
import { InputError, TheHoodError } from "../runtime/errors.js";
import { readLatestExternalTransferManifest } from "../runtime/externalTransfer.js";
import { captureGitEvidence } from "../runtime/gitEvidence.js";
import type { LocalStateIgnoreResult } from "../runtime/localStateIgnore.js";
import { recommendLoop } from "../runtime/loopRecommendation.js";
import { advanceRun } from "../runtime/loop.js";
import { runAutopilotLoop } from "../runtime/loopRunner.js";
import { startMcpServer } from "../mcp/server.js";
import { readRunArtifact, type ReadArtifactResult } from "../runtime/artifacts.js";
import { fanoutAgents, type FanoutItemInput } from "../runtime/fanout.js";
import { listProvidersWithRuntimeModels } from "../runtime/providers.js";
import { assertRoleInvariants } from "../runtime/permissions.js";
import { reconcileRun } from "../runtime/reconciliation.js";
import { buildRoleRoster } from "../runtime/roleRoster.js";
import { parseRole, parseRoleAssignment } from "../runtime/role-assignment.js";
import { getRunInsights } from "../runtime/runInsights.js";
import { runMonitorFromRuns } from "../runtime/runMonitor.js";
import { getProjectPaths } from "../runtime/paths.js";
import { summonAgent } from "../runtime/summons.js";
import { applyTeamPreset, getTeamPreset, listTeamPresets, teamPresetIds } from "../runtime/teamPresets.js";
import {
  abortRun,
  createRun,
  getRun,
  listRuns,
  recordApproval
} from "../runtime/runtime.js";
import { approvalInboxViewFromRuns, approvalMessageHint } from "../runtime/approvalInbox.js";
import {
  approvalDecisions,
  runModes,
  type ApprovalDecision,
  type ApprovalPolicyMode,
  type ExternalTransferApprovalMode,
  type RoleMap,
  type RunMode
} from "../runtime/types.js";
import {
  getBooleanOption,
  getStringListOption,
  getStringOption,
  parseArgs,
  type CliOptionValue
} from "./args.js";
import { getMcpConfigReport, getMcpTunnelConfigReport } from "./mcpConfig.js";
import {
  formatBrowserStartResult,
  formatBrowserStatus,
  formatBrowserStopResult,
  formatCliSetupReport,
  formatConfig,
  formatAdvanceRunResult,
  formatAgentBoard,
  formatCommandResult,
  formatDoctorReport,
  formatGitEvidence,
  formatLoopRecommendation,
  formatMcpConfigReport,
  formatMcpTunnelConfigReport,
  formatExternalTransferPreview,
  formatFanoutAgentsResult,
  formatRunLoopResult,
  formatProviders,
  formatReconcileRunResult,
  formatRoleRoster,
  formatRoles,
  formatRunEvents,
  formatRunList,
  formatRunSummary,
  formatSummonAgentResult,
  printJson,
  type CliSetupReport
} from "./format.js";
import {
  renderApprovalInbox,
  renderDashboard,
  renderSettingsCockpit,
  settingsPageIds,
  type SettingsPageId
} from "../tui/dashboard.js";
import type { RunArtifact } from "../runtime/types.js";

const helpText = `TheHood local agent runtime

Usage:
  thehood init [--repo <path>]
  thehood setup [--repo <path>] [--json]
  thehood config show [--repo <path>] [--json]
  thehood config set max-iterations|fanout-max-items <n> [--repo <path>] [--json]
  thehood providers [--repo <path>] [--json]
  thehood doctor [--repo <path>] [--json]
  thehood models [--repo <path>] [--json]
  thehood roster [--repo <path>] [--json]
  thehood agent-board [run-id] [--repo <path>] [--artifact] [--json]
  thehood teams [apply <preset>] [--repo <path>] [--json]
  thehood roles [--repo <path>] [--json]
  thehood roles set <role> <provider:model> [--repo <path>]
  thehood recommend-loop <goal> [--repo <path>] [--constraint <text>] [--acceptance <text>] [--validation <command>] [--allowed-path <path>] [--forbidden-change <text>] [--max-iterations <n>] [--json]
  thehood goal <goal> [--repo <path>] [--max-iterations <n>] [--max-cycles <n>] [--max-steps <n>] [--json]
  thehood plan <goal> [--repo <path>] [--loop] [--max-cycles <n>] [--max-steps <n>] [--json]
  thehood run <goal> [--repo <path>] [--mode <mode>] [--loop] [--max-cycles <n>] [--max-steps <n>] [--json]
  thehood status [run-id] [--repo <path>] [--json]
  thehood logs <run-id> [--repo <path>] [--json]
  thehood artifact <run-id> <artifact-ref> [--repo <path>] [--max-bytes <n>] [--json]
  thehood evidence <run-id> [--repo <path>] [--json]
  thehood diff <run-id> [--repo <path>] [--max-bytes <n>] [--json]
  thehood exec <run-id> [--repo <path>] [--cwd <path>] [--allow-risky] -- <command> [args...]
  thehood approve <run-id> [--repo <path>] [--reason <text>]
  thehood reject <run-id> [--repo <path>] [--reason <text>]
  thehood revise <run-id> [--repo <path>] [--reason <text>]
  thehood approvals policy [show|set mode manual|auto-low-risk|autopilot|set external-transfers manual|auto-low-risk] [--repo <path>] [--json]
  thehood continue <run-id> [--repo <path>] [--json]
  thehood loop <run-id> [--repo <path>] [--max-cycles <n>] [--max-steps <n>] [--json]
  thehood reconcile <run-id> [--repo <path>] [--role planner|orchestrator] [--json]
  thehood summon <run-id> --role <role> --brief <text> [--agent <provider:model>] [--kind <kind>] [--json]
  thehood fanout <run-id> --items-json <json-array> [--max-items <n>] [--repo <path>] [--json]
  thehood transfer preview <run-id> [--repo <path>] [--json]
  thehood abort <run-id> [--repo <path>] [--reason <text>]
  thehood browser start [--port <n>] [--profile <name>] [--profile-path <path>] [--chrome-path <path>]
  thehood browser status [--port <n>] [--cdp-url <url>] [--profile <name>] [--profile-path <path>] [--json]
  thehood browser stop [--port <n>] [--profile <name>] [--profile-path <path>] [--json]
  thehood ui [approvals|settings [overview|crew|providers|budgets|safety|browser|commands|all]] [--repo <path>] [--port <n>] [--cdp-url <url>] [--approve <run-id>] [--reject <run-id>] [--revise <run-id>] [--json]
  thehood mcp
  thehood mcp config [--json] [--chatgpt-web] [--cdp-url <url>]
  thehood mcp tunnel [--profile <name>] [--tunnel-id <id>] [--json]

Role override options for plan/run:
  --orchestrator provider:model
  --planner provider:model
  --researcher provider:model
  --implementer provider:model
  --qa provider:model
  --verifier provider:model
  --critic provider:model
  --constraint "text"

Summon roles:
  orchestrator | planner | researcher | qa | verifier | critic

Fan-out item JSON:
  [{"role":"qa","agent":"stub:qa","brief":"QA sidecar"},{"role":"critic","agent":"stub:critic","brief":"Critique sidecar"}]

Common team presets:
  codex-default | pro-orchestrator | claude-critic | claude-second-judge
  spark-plus-sonnet | claude-builder | pro-claude-high-assurance

Model examples:
  codex-cli:spark | chatgpt-web:chatgpt-pro | chatgpt-web:configured
  claude-code:sonnet | claude-code:fable | claude-code:mythos
`;

const repoFromOptions = (options: Record<string, CliOptionValue>): string =>
  getStringOption(options, "repo") ?? process.cwd();

const shouldPrintJson = (options: Record<string, CliOptionValue>): boolean =>
  getBooleanOption(options, "json");

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

const currentCliEntryPath = (): string => {
  const entry = process.argv[1];
  return entry ? path.resolve(entry) : path.resolve("dist/cli/main.js");
};

const buildCliSetupReport = (options: Record<string, CliOptionValue>): CliSetupReport => {
  const entryPath = currentCliEntryPath();
  const packageRoot = path.resolve(path.dirname(entryPath), "..", "..");
  const repoPath = repoFromOptions(options);
  const localBuildCommand = `node ${shellQuote(entryPath)}`;
  const installedCommand = "thehood";
  const repoArg = `--repo ${shellQuote(repoPath)}`;

  return {
    commandName: installedCommand,
    repoPath,
    localBuildCommand,
    installedCommand,
    oneSessionAlias: `alias thehood=${shellQuote(`node ${entryPath}`)}`,
    npmLinkCommand: `cd ${shellQuote(packageRoot)} && npm link`,
    npmInstallCommand: "npm install -g thehood",
    localMcpConfigCommand: `${localBuildCommand} mcp config`,
    installedMcpConfigCommand: `${installedCommand} mcp config`,
    localUiCommand: `${localBuildCommand} ui ${repoArg}`,
    installedUiCommand: `${installedCommand} ui ${repoArg}`,
    notes: [
      "Use the local build command while developing this checkout.",
      "Run npm run build after source edits so dist/cli/main.js reflects the current code.",
      "npm link is optional and creates a global shell command pointing at this checkout.",
      "npm install -g is for a published or otherwise available package."
    ]
  };
};

const parseSettingsPage = (value: string | undefined): SettingsPageId => {
  if (value === undefined) {
    return "overview";
  }

  if ((settingsPageIds as readonly string[]).includes(value)) {
    return value as SettingsPageId;
  }

  throw new InputError(`Unknown settings page "${value}". Expected one of: ${settingsPageIds.join(", ")}.`);
};

const isSettingsPage = (value: string | undefined): value is SettingsPageId =>
  Boolean(value && (settingsPageIds as readonly string[]).includes(value));

const parseMode = (value: string | undefined, fallback: RunMode): RunMode => {
  if (value === undefined) {
    return fallback;
  }

  if ((runModes as readonly string[]).includes(value)) {
    return value as RunMode;
  }

  throw new InputError(`Invalid mode "${value}". Expected one of: ${runModes.join(", ")}.`);
};

const parseRoleOverrides = (options: Record<string, CliOptionValue>): RoleMap => {
  const overrides: RoleMap = {};

  for (const role of ["orchestrator", "planner", "researcher", "implementer", "qa", "verifier", "critic"] as const) {
    const value = getStringOption(options, role);
    if (value) {
      overrides[role] = parseRoleAssignment(value);
    }
  }

  return overrides;
};

const parseDecision = (value: string): ApprovalDecision => {
  if ((approvalDecisions as readonly string[]).includes(value)) {
    return value as ApprovalDecision;
  }

  throw new InputError(`Invalid approval decision "${value}".`);
};

const parseExternalTransferApprovalMode = (value: string): ExternalTransferApprovalMode => {
  const normalized = value.replace(/-/g, "_");

  if (normalized === "manual" || normalized === "auto_low_risk") {
    return normalized;
  }

  throw new InputError("External transfer policy must be manual or auto-low-risk.");
};

const parseApprovalPolicyMode = (value: string): ApprovalPolicyMode => {
  const normalized = value.replace(/-/g, "_");

  if (normalized === "manual" || normalized === "auto_low_risk" || normalized === "autopilot") {
    return normalized;
  }

  throw new InputError("Approval policy mode must be manual, auto-low-risk, or autopilot.");
};

const ensureRunId = (value: string | undefined): string => {
  if (!value) {
    throw new InputError("Run id is required.");
  }

  return value;
};

const parsePositiveIntegerOption = (
  options: Record<string, CliOptionValue>,
  key: string
): number | undefined => {
  const raw = getStringOption(options, key);

  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw.trim()) {
    throw new InputError(`Option --${key} must be a positive integer.`);
  }

  return parsed;
};

const parsePositiveIntegerValue = (value: string | undefined, label: string): number => {
  if (value === undefined) {
    throw new InputError(`${label} is required.`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
    throw new InputError(`${label} must be a positive integer.`);
  }

  return parsed;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requiredStringField = (value: Record<string, unknown>, key: string, label: string): string => {
  const raw = value[key];

  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw;
  }

  throw new InputError(`${label}.${key} must be a non-empty string.`);
};

const optionalStringField = (value: Record<string, unknown>, key: string, label: string): string | undefined => {
  const raw = value[key];

  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw;
  }

  throw new InputError(`${label}.${key} must be a non-empty string when provided.`);
};

const optionalStringArrayField = (value: Record<string, unknown>, key: string, label: string): string[] => {
  const raw = value[key];

  if (raw === undefined) {
    return [];
  }

  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
    return raw;
  }

  throw new InputError(`${label}.${key} must be an array of strings when provided.`);
};

const parseFanoutItem = (value: unknown, index: number): FanoutItemInput => {
  if (!isPlainObject(value)) {
    throw new InputError(`Fan-out item ${index + 1} must be an object.`);
  }

  const label = `itemsJson[${index}]`;
  const agent = optionalStringField(value, "agent", label);
  const summonKind = optionalStringField(value, "kind", label) ?? optionalStringField(value, "summonKind", label);
  const persona = optionalStringField(value, "persona", label);
  const evidenceRefs = [
    ...optionalStringArrayField(value, "evidenceRefs", label),
    ...optionalStringArrayField(value, "evidence_refs", label)
  ];

  return {
    role: parseRole(requiredStringField(value, "role", label)),
    brief: requiredStringField(value, "brief", label),
    ...(summonKind ? { summonKind } : {}),
    ...(persona ? { persona } : {}),
    ...(agent ? { agent: parseRoleAssignment(agent) } : {}),
    constraints: optionalStringArrayField(value, "constraints", label),
    evidenceRefs
  };
};

const parseFanoutItems = (options: Record<string, CliOptionValue>): FanoutItemInput[] => {
  const raw = getStringOption(options, "itemsJson");

  if (!raw) {
    throw new InputError("Option --items-json is required for fanout.");
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      throw new InputError("Option --items-json must be a JSON array.");
    }

    return parsed.map(parseFanoutItem);
  } catch (error) {
    if (error instanceof InputError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(`Invalid --items-json: ${message}`);
  }
};

const artifactReadOptions = (
  options: Record<string, CliOptionValue>
): { maxBytes?: number } => {
  const maxBytes = parsePositiveIntegerOption(options, "maxBytes");
  return maxBytes === undefined ? {} : { maxBytes };
};

const browserOptionsFromCli = (options: Record<string, CliOptionValue>): BrowserManagerOptions => {
  const port = parsePositiveIntegerOption(options, "port");
  const cdpUrl = getStringOption(options, "cdpUrl");
  const profile = getStringOption(options, "profile");
  const profilePath = getStringOption(options, "profilePath");
  const url = getStringOption(options, "url");
  const chromePath = getStringOption(options, "chromePath");

  return {
    ...(port === undefined ? {} : { port }),
    ...(cdpUrl ? { cdpUrl } : {}),
    ...(profile ? { profile } : {}),
    ...(profilePath ? { profilePath } : {}),
    ...(url ? { url } : {}),
    ...(chromePath ? { chromePath } : {})
  };
};

const writeArtifactReadResult = (
  result: ReadArtifactResult,
  options: Record<string, CliOptionValue>
): void => {
  if (shouldPrintJson(options)) {
    printJson(result);
    return;
  }

  process.stdout.write(result.content);
  if (result.truncated) {
    const prefix = result.content.endsWith("\n") ? "" : "\n";
    process.stderr.write(
      `${prefix}thehood: artifact truncated from ${result.byteLength} byte(s). Use --max-bytes to read more.\n`
    );
  }
};

const latestDiffArtifact = (artifacts: RunArtifact[]): RunArtifact => {
  const artifact = artifacts.filter((candidate) => candidate.kind === "diff").at(-1);

  if (!artifact) {
    throw new InputError("Run does not have a diff artifact.");
  }

  return artifact;
};

const formatLocalStateIgnoreResult = (result: LocalStateIgnoreResult): string => {
  const entries = result.ignoredEntries.join(", ");

  switch (result.status) {
    case "updated":
      return `Protected local state in git exclude: ${result.excludePath} (${entries})`;
    case "already_ignored":
      return `Local state already protected by git exclude: ${result.excludePath} (${entries})`;
    case "not_git_repo":
      return `Local state ignore not updated because this path is not a git checkout (${entries})`;
  }
};

const handleInit = async (options: Record<string, CliOptionValue>): Promise<void> => {
  const result = await initConfig(repoFromOptions(options));

  if (shouldPrintJson(options)) {
    printJson(result);
    return;
  }

  process.stdout.write(
    [
      `${result.created ? "Created" : "Found existing"} config: ${result.configPath}`,
      formatLocalStateIgnoreResult(result.localStateIgnore)
    ].join("\n") + "\n"
  );
};

const handleSetup = async (options: Record<string, CliOptionValue>): Promise<void> => {
  const report = buildCliSetupReport(options);
  shouldPrintJson(options) ? printJson(report) : process.stdout.write(`${formatCliSetupReport(report)}\n`);
};

const handleConfig = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const subcommand = args[0] ?? "show";

  if (subcommand === "show") {
    const config = await loadConfig(repoFromOptions(options));
    shouldPrintJson(options) ? printJson(config) : process.stdout.write(`${formatConfig(config)}\n`);
    return;
  }

  if (subcommand !== "set") {
    throw new InputError(`Unknown config subcommand "${subcommand}".`);
  }

  const repoPath = repoFromOptions(options);
  const config = await loadConfig(repoPath);
  const key = args[1];
  const value = args[2];
  let updated = config;

  if (key === "max-iterations") {
    updated = {
      ...config,
      defaults: {
        ...config.defaults,
        maxIterations: parsePositiveIntegerValue(value, "max-iterations")
      }
    };
  } else if (key === "fanout-max-items") {
    const fanoutMaxItems = parsePositiveIntegerValue(value, "fanout-max-items");
    if (fanoutMaxItems > 8) {
      throw new InputError("fanout-max-items cannot exceed 8.");
    }

    updated = {
      ...config,
      defaults: {
        ...config.defaults,
        fanoutMaxItems
      }
    };
  } else {
    throw new InputError("Use: thehood config set max-iterations|fanout-max-items <positive-integer>");
  }

  await writeConfig(repoPath, updated);
  shouldPrintJson(options) ? printJson(updated) : process.stdout.write(`${formatConfig(updated)}\n`);
};

const handleProviders = async (options: Record<string, CliOptionValue>): Promise<void> => {
  const config = await loadConfig(repoFromOptions(options));
  const providers = listProvidersWithRuntimeModels(config);
  shouldPrintJson(options) ? printJson(providers) : process.stdout.write(`${formatProviders(providers)}\n`);
};

const handleDoctor = async (options: Record<string, CliOptionValue>): Promise<void> => {
  const config = await loadConfig(repoFromOptions(options));
  const report = await inspectRuntimeHealth(config);
  shouldPrintJson(options) ? printJson(report) : process.stdout.write(`${formatDoctorReport(report)}\n`);
};

const handleRoles = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const repoPath = repoFromOptions(options);
  const config = await loadConfig(repoPath);

  if (args[0] === "set") {
    const role = parseRole(args[1] ?? "");
    const assignment = parseRoleAssignment(args[2] ?? "");
    const updated = {
      ...config,
      roles: {
        ...config.roles,
        [role]: assignment
      }
    };

    assertRoleInvariants(updated.roles);
    await writeConfig(repoPath, updated);
    if (shouldPrintJson(options)) {
      printJson({ role, assignment, roles: updated.roles });
      return;
    }

    process.stdout.write(`${role}: ${assignment.provider}:${assignment.model}\n`);
    return;
  }

  shouldPrintJson(options) ? printJson(config.roles) : process.stdout.write(`${formatRoles(config.roles)}\n`);
};

const handleRoster = async (options: Record<string, CliOptionValue>): Promise<void> => {
  const repoPath = repoFromOptions(options);
  const config = await loadConfig(repoPath);
  const health = await inspectRuntimeHealth(config);
  const roster = buildRoleRoster(config, health);

  shouldPrintJson(options)
    ? printJson({ repoPath, roster })
    : process.stdout.write(`${formatRoleRoster(roster, repoPath)}\n`);
};

const buildAgentBoardForCli = async (
  repoPath: string,
  runId: string | undefined,
  existingRun?: Awaited<ReturnType<typeof getRun>>,
  existingInsights?: Awaited<ReturnType<typeof getRunInsights>>
) => {
  const config = await loadConfig(repoPath);
  const health = await inspectRuntimeHealth(config);
  const roster = buildRoleRoster(config, health);

  if (!runId) {
    return buildAgentBoard({ repoPath, roster });
  }

  const run = existingRun ?? await getRun(repoPath, runId);
  const insights = existingInsights ?? await getRunInsights(run);

  return buildAgentBoard({ repoPath, roster, run, insights });
};

const handleAgentBoard = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const board = await buildAgentBoardForCli(repoFromOptions(options), args[0]);
  const output = getBooleanOption(options, "artifact")
    ? {
        board,
        artifact: buildAgentBoardArtifact(board)
      }
    : board;

  shouldPrintJson(options)
    ? printJson(output)
    : process.stdout.write(`${formatAgentBoard(board)}\n`);
};

const handleTeams = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const subcommand = args[0] ?? "list";

  if (subcommand === "list") {
    const presets = listTeamPresets();
    if (shouldPrintJson(options)) {
      printJson({ presets });
      return;
    }

    process.stdout.write(`${presets.map((preset) => `${preset.id}: ${preset.summary}`).join("\n")}\n`);
    return;
  }

  if (subcommand !== "apply") {
    throw new InputError(`Unknown teams subcommand "${subcommand}".`);
  }

  const presetId = args[1] ?? "";
  const preset = getTeamPreset(presetId);
  if (!preset) {
    throw new InputError(`Unknown team preset "${presetId}". Expected one of: ${teamPresetIds().join(", ")}.`);
  }

  const repoPath = repoFromOptions(options);
  const config = await loadConfig(repoPath);
  const updated = applyTeamPreset(config, preset);
  assertRoleInvariants(updated.roles);
  await writeConfig(repoPath, updated);

  if (shouldPrintJson(options)) {
    printJson({ preset, config: updated });
    return;
  }

  process.stdout.write(`Applied team preset ${preset.id}: ${preset.summary}\n${formatRoles(updated.roles)}\n`);
};

const handleCreateRun = async (
  command: "goal" | "plan" | "run",
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const goal = args.join(" ").trim();
  const mode = command === "plan" ? "plan" : parseMode(getStringOption(options, "mode"), "implement");
  const shouldLoop = command === "goal" || getBooleanOption(options, "loop");
  const maxIterations = parsePositiveIntegerOption(options, "maxIterations");
  const run = await createRun({
    repoPath: repoFromOptions(options),
    goal,
    mode,
    roleOverrides: parseRoleOverrides(options),
    constraints: getStringListOption(options, "constraint"),
    ...(maxIterations === undefined ? {} : { maxIterations })
  });

  if (shouldLoop) {
    const maxCycles = parsePositiveIntegerOption(options, "maxCycles");
    const maxStepsPerCycle = parsePositiveIntegerOption(options, "maxSteps");
    const result = await runAutopilotLoop({
      repoPath: run.repoPath,
      runId: run.runId,
      ...(maxCycles === undefined ? {} : { maxCycles }),
      ...(maxStepsPerCycle === undefined ? {} : { maxStepsPerCycle })
    });

    shouldPrintJson(options) ? printJson(result) : process.stdout.write(`${formatRunLoopResult(result)}\n`);
    return;
  }

  shouldPrintJson(options) ? printJson(run) : process.stdout.write(`${formatRunSummary(run)}\n`);
};

const handleRecommendLoop = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const goal = args.join(" ").trim();
  const maxIterations = parsePositiveIntegerOption(options, "maxIterations");
  const recommendation = await recommendLoop({
    repoPath: repoFromOptions(options),
    goal,
    constraints: getStringListOption(options, "constraint"),
    acceptanceCriteria: getStringListOption(options, "acceptance"),
    validationCommands: getStringListOption(options, "validation"),
    allowedPaths: getStringListOption(options, "allowedPath"),
    forbiddenChanges: getStringListOption(options, "forbiddenChange"),
    ...(maxIterations === undefined ? {} : { maxIterations })
  });

  shouldPrintJson(options)
    ? printJson(recommendation)
    : process.stdout.write(`${formatLoopRecommendation(recommendation)}\n`);
};

const handleStatus = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const repoPath = repoFromOptions(options);

  if (!args[0]) {
    const runs = await listRuns(repoPath);
    shouldPrintJson(options) ? printJson(runs) : process.stdout.write(`${formatRunList(runs)}\n`);
    return;
  }

  const run = await getRun(repoPath, args[0]);
  const insights = await getRunInsights(run);
  const agentBoard = await buildAgentBoardForCli(repoPath, run.runId, run, insights);
  shouldPrintJson(options)
    ? printJson({ ...run, insights, agentBoard })
    : process.stdout.write(`${formatRunSummary(run, insights)}\n`);
};

const handleLogs = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const run = await getRun(repoFromOptions(options), ensureRunId(args[0]));
  shouldPrintJson(options) ? printJson(run.events) : process.stdout.write(`${formatRunEvents(run)}\n`);
};

const handleArtifact = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const runId = ensureRunId(args[0]);
  const ref = args[1];

  if (!ref) {
    throw new InputError("Artifact ref is required. Use: thehood artifact <run-id> <artifact-ref>");
  }

  const result = await readRunArtifact({
    repoPath: repoFromOptions(options),
    runId,
    ref,
    ...artifactReadOptions(options)
  });

  writeArtifactReadResult(result, options);
};

const handleDiff = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const repoPath = repoFromOptions(options);
  const runId = ensureRunId(args[0]);
  const run = await getRun(repoPath, runId);
  const artifact = latestDiffArtifact(run.artifacts);
  const result = await readRunArtifact({
    repoPath,
    runId,
    ref: artifact.ref,
    ...artifactReadOptions(options)
  });

  writeArtifactReadResult(result, options);
};

const handleEvidence = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const result = await captureGitEvidence(repoFromOptions(options), ensureRunId(args[0]));
  shouldPrintJson(options) ? printJson(result) : process.stdout.write(`${formatGitEvidence(result)}\n`);
};

const handleExec = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const runId = ensureRunId(args[0]);
  const command = args[1];

  if (!command) {
    throw new InputError("Command is required after run id. Use: thehood exec <run-id> -- <command> [args...]");
  }

  const cwd = getStringOption(options, "cwd");
  const result = await runRuntimeCommand({
    repoPath: repoFromOptions(options),
    runId,
    command,
    args: args.slice(2),
    ...(cwd ? { cwd } : {}),
    allowRisky: getBooleanOption(options, "allowRisky")
  });

  shouldPrintJson(options) ? printJson(result) : process.stdout.write(`${formatCommandResult(result)}\n`);
};

const handleApprovalCommand = async (
  command: "approve" | "reject" | "revise",
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const decision = parseDecision(command);
  const reason = getStringOption(options, "reason") ?? `${command} requested from CLI`;
  const run = await recordApproval(repoFromOptions(options), ensureRunId(args[0]), decision, reason);
  shouldPrintJson(options) ? printJson(run) : process.stdout.write(`${formatRunSummary(run)}\n`);
};

const handleApprovals = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const subcommand = args[0] ?? "policy";

  if (subcommand !== "policy") {
    throw new InputError(`Unknown approvals subcommand "${subcommand}".`);
  }

  const action = args[1] ?? "show";
  const repoPath = repoFromOptions(options);
  const config = await loadConfig(repoPath);

  if (action === "show") {
    shouldPrintJson(options) ? printJson(config.approvalPolicy) : process.stdout.write(`${formatConfig(config)}\n`);
    return;
  }

  if (action !== "set") {
    throw new InputError("Use: thehood approvals policy set mode manual|auto-low-risk|autopilot");
  }

  if (args[2] === "mode") {
    const mode = parseApprovalPolicyMode(args[3] ?? "");
    const externalTransferMode: ExternalTransferApprovalMode = mode === "manual" ? "manual" : "auto_low_risk";
    const updated = {
      ...config,
      approvalPolicy: {
        ...config.approvalPolicy,
        mode,
        externalTransfers: {
          ...config.approvalPolicy.externalTransfers,
          mode: externalTransferMode
        }
      }
    };

    await writeConfig(repoPath, updated);
    shouldPrintJson(options) ? printJson(updated.approvalPolicy) : process.stdout.write(`${formatConfig(updated)}\n`);
    return;
  }

  if (args[2] === "external-transfers") {
    const mode = parseExternalTransferApprovalMode(args[3] ?? "");
    const updated = {
      ...config,
      approvalPolicy: {
        ...config.approvalPolicy,
        externalTransfers: {
          ...config.approvalPolicy.externalTransfers,
          mode
        }
      }
    };

    await writeConfig(repoPath, updated);
    shouldPrintJson(options) ? printJson(updated.approvalPolicy) : process.stdout.write(`${formatConfig(updated)}\n`);
    return;
  }

  throw new InputError("Use: thehood approvals policy set mode manual|auto-low-risk|autopilot");
};

const handleContinue = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const result = await advanceRun({
    repoPath: repoFromOptions(options),
    runId: ensureRunId(args[0])
  });

  shouldPrintJson(options) ? printJson(result) : process.stdout.write(`${formatAdvanceRunResult(result)}\n`);
};

const handleLoop = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const maxCycles = parsePositiveIntegerOption(options, "maxCycles");
  const maxStepsPerCycle = parsePositiveIntegerOption(options, "maxSteps");
  const result = await runAutopilotLoop({
    repoPath: repoFromOptions(options),
    runId: ensureRunId(args[0]),
    ...(maxCycles === undefined ? {} : { maxCycles }),
    ...(maxStepsPerCycle === undefined ? {} : { maxStepsPerCycle })
  });

  shouldPrintJson(options) ? printJson(result) : process.stdout.write(`${formatRunLoopResult(result)}\n`);
};

const handleReconcile = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const roleValue = getStringOption(options, "role");
  const role = roleValue ? parseRole(roleValue) : undefined;
  const result = await reconcileRun({
    repoPath: repoFromOptions(options),
    runId: ensureRunId(args[0]),
    ...(role ? { role } : {})
  });

  shouldPrintJson(options) ? printJson(result) : process.stdout.write(`${formatReconcileRunResult(result)}\n`);
};

const handleSummon = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const roleValue = getStringOption(options, "role");
  if (!roleValue) {
    throw new InputError("Option --role is required for summon.");
  }

  const brief = getStringOption(options, "brief") ?? args.slice(1).join(" ").trim();
  const agent = getStringOption(options, "agent");
  const persona = getStringOption(options, "persona");
  const summonKind = getStringOption(options, "kind");
  const result = await summonAgent({
    repoPath: repoFromOptions(options),
    runId: ensureRunId(args[0]),
    role: parseRole(roleValue),
    brief,
    ...(summonKind ? { summonKind } : {}),
    ...(persona ? { persona } : {}),
    ...(agent ? { agent: parseRoleAssignment(agent) } : {}),
    constraints: getStringListOption(options, "constraint"),
    evidenceRefs: getStringListOption(options, "evidence")
  });

  shouldPrintJson(options) ? printJson(result) : process.stdout.write(`${formatSummonAgentResult(result)}\n`);
};

const handleFanout = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const maxItems = parsePositiveIntegerOption(options, "maxItems");
  const result = await fanoutAgents({
    repoPath: repoFromOptions(options),
    runId: ensureRunId(args[0]),
    items: parseFanoutItems(options),
    ...(maxItems === undefined ? {} : { maxItems })
  });

  shouldPrintJson(options) ? printJson(result) : process.stdout.write(`${formatFanoutAgentsResult(result)}\n`);
};

const handleTransfer = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const subcommand = args[0] ?? "preview";

  if (subcommand !== "preview") {
    throw new InputError(`Unknown transfer subcommand "${subcommand}".`);
  }

  const repoPath = repoFromOptions(options);
  const run = await getRun(repoPath, ensureRunId(args[1]));
  const preview = await readLatestExternalTransferManifest(run);

  shouldPrintJson(options) ? printJson(preview) : process.stdout.write(`${formatExternalTransferPreview(preview)}\n`);
};

const handleAbort = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const reason = getStringOption(options, "reason") ?? "Aborted from CLI.";
  const run = await abortRun(repoFromOptions(options), ensureRunId(args[0]), reason);
  shouldPrintJson(options) ? printJson(run) : process.stdout.write(`${formatRunSummary(run)}\n`);
};

const handleMcp = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  if (args[0] === "config") {
    const cdpUrl = getStringOption(options, "cdpUrl");
    const report = getMcpConfigReport(process.argv[1], {
      includeChatGptWeb: getBooleanOption(options, "chatgptWeb"),
      ...(cdpUrl ? { cdpUrl } : {})
    });
    shouldPrintJson(options) ? printJson(report) : process.stdout.write(`${formatMcpConfigReport(report)}\n`);
    return;
  }

  if (args[0] === "tunnel" || args[0] === "tunnel-config") {
    const profile = getStringOption(options, "profile");
    const tunnelId = getStringOption(options, "tunnelId");
    const report = getMcpTunnelConfigReport(process.argv[1], {
      ...(profile ? { profile } : {}),
      ...(tunnelId ? { tunnelId } : {})
    });
    shouldPrintJson(options) ? printJson(report) : process.stdout.write(`${formatMcpTunnelConfigReport(report)}\n`);
    return;
  }

  if (args.length > 0) {
    throw new InputError(`Unknown mcp subcommand "${args[0]}".`);
  }

  await startMcpServer();
};

const handleBrowser = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const subcommand = args[0] ?? "status";
  const browserOptions = browserOptionsFromCli(options);

  if (subcommand === "status") {
    const status = await inspectBrowser(browserOptions);
    shouldPrintJson(options) ? printJson(status) : process.stdout.write(`${formatBrowserStatus(status)}\n`);
    return;
  }

  if (subcommand === "start") {
    const result = await startBrowser(browserOptions);
    shouldPrintJson(options) ? printJson(result) : process.stdout.write(`${formatBrowserStartResult(result)}\n`);
    return;
  }

  if (subcommand === "stop") {
    const result = await stopBrowser(browserOptions);
    shouldPrintJson(options) ? printJson(result) : process.stdout.write(`${formatBrowserStopResult(result)}\n`);
    return;
  }

  throw new InputError(`Unknown browser subcommand "${subcommand}".`);
};

const handleUi = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const subcommand = args[0];

  if (subcommand === "set") {
    const key = args[1];
    const value = args[2];

    if (!key || !value || args.length > 3) {
      throw new InputError("Usage: thehood ui set approval-mode|external-transfers|max-iterations|fanout-max-items <value>.");
    }

    if (key === "approval-mode") {
      await handleApprovals(["policy", "set", "mode", value], options);
      return;
    }

    if (key === "external-transfers") {
      await handleApprovals(["policy", "set", "external-transfers", value], options);
      return;
    }

    if (key === "max-iterations" || key === "fanout-max-items") {
      await handleConfig(["set", key, value], options);
      return;
    }

    throw new InputError("Usage: thehood ui set approval-mode|external-transfers|max-iterations|fanout-max-items <value>.");
  }

  if (subcommand === "team") {
    if (!args[1] || args.length > 2) {
      throw new InputError("Usage: thehood ui team <preset>.");
    }

    await handleTeams(["apply", args[1]], options);
    return;
  }

  if (subcommand === "role") {
    if (!args[1] || !args[2] || args.length > 3) {
      throw new InputError("Usage: thehood ui role <role> <provider:model>.");
    }

    await handleRoles(["set", args[1], args[2]], options);
    return;
  }

  const settingsPage = subcommand === "settings"
    ? parseSettingsPage(args[1])
    : isSettingsPage(subcommand)
      ? subcommand
      : undefined;

  if (subcommand && subcommand !== "approvals" && subcommand !== "settings" && !settingsPage) {
    throw new InputError(`Unknown ui subcommand "${subcommand}".`);
  }
  if (subcommand === "settings" && args.length > 2) {
    throw new InputError("Usage: thehood ui settings [overview|crew|providers|budgets|safety|browser|commands|all].");
  }
  if (settingsPage && subcommand !== "settings" && args.length > 1) {
    throw new InputError("Usage: thehood ui settings [overview|crew|providers|budgets|safety|browser|commands|all].");
  }

  const repoPath = repoFromOptions(options);
  const approvalAction = (
    [
      ["approve", getStringOption(options, "approve")],
      ["reject", getStringOption(options, "reject")],
      ["revise", getStringOption(options, "revise")]
    ] as const
  ).find(([, runId]) => runId !== undefined);

  if (approvalAction) {
    const [decision, runId] = approvalAction;
    if (!runId) {
      throw new InputError(`Run id is required for --${decision}.`);
    }

    const run = await getRun(repoPath, runId);
    const reason = getStringOption(options, "reason") ?? (
      decision === "approve"
        ? approvalMessageHint(run)
        : decision === "reject"
          ? `Rejected from TheHood UI for run ${run.runId}.`
          : `Revision requested from TheHood UI for run ${run.runId}.`
    );
    const updated = await recordApproval(repoPath, run.runId, decision, reason);

    shouldPrintJson(options) ? printJson(updated) : process.stdout.write(`${formatRunSummary(updated)}\n`);
    return;
  }

  const config = await loadConfig(repoPath);
  const health = await inspectRuntimeHealth(config);
  const roleRoster = buildRoleRoster(config, health);
  const browser = await inspectBrowser(browserOptionsFromCli(options));

  if (settingsPage) {
    const settings = {
      page: settingsPage,
      repoPath,
      configPath: getProjectPaths(repoPath).configPath,
      config,
      health,
      roleRoster,
      providers: listProvidersWithRuntimeModels(config),
      teamPresets: listTeamPresets(),
      browser
    };

    shouldPrintJson(options)
      ? printJson(settings)
      : process.stdout.write(`${renderSettingsCockpit(settings, { page: settingsPage })}\n`);
    return;
  }

  const runs = await listRuns(repoPath);
  const approvalInbox = approvalInboxViewFromRuns(runs);
  const runMonitor = runMonitorFromRuns(runs);
  const dashboard = {
    repoPath,
    health,
    roleRoster,
    browser,
    approvalPolicy: config.approvalPolicy,
    runMonitor,
    approvalInbox
  };

  if (shouldPrintJson(options)) {
    printJson(subcommand === "approvals" ? approvalInbox : dashboard);
    return;
  }

  process.stdout.write(
    `${subcommand === "approvals" ? renderApprovalInbox(approvalInbox) : renderDashboard(dashboard)}\n`
  );
};

const runCli = async (argv: string[]): Promise<void> => {
  const parsed = parseArgs(argv);
  const [command, ...args] = parsed.positionals;

  if (!command || command === "help" || command === "--help") {
    process.stdout.write(helpText);
    return;
  }

  switch (command) {
    case "init":
      await handleInit(parsed.options);
      return;
    case "setup":
      await handleSetup(parsed.options);
      return;
    case "config":
      await handleConfig(args, parsed.options);
      return;
    case "providers":
    case "models":
      await handleProviders(parsed.options);
      return;
    case "doctor":
      await handleDoctor(parsed.options);
      return;
    case "roster":
      await handleRoster(parsed.options);
      return;
    case "agent-board":
      await handleAgentBoard(args, parsed.options);
      return;
    case "teams":
      await handleTeams(args, parsed.options);
      return;
    case "roles":
      await handleRoles(args, parsed.options);
      return;
    case "recommend-loop":
      await handleRecommendLoop(args, parsed.options);
      return;
    case "goal":
    case "plan":
    case "run":
      await handleCreateRun(command, args, parsed.options);
      return;
    case "status":
      await handleStatus(args, parsed.options);
      return;
    case "logs":
      await handleLogs(args, parsed.options);
      return;
    case "artifact":
      await handleArtifact(args, parsed.options);
      return;
    case "evidence":
      await handleEvidence(args, parsed.options);
      return;
    case "diff":
      await handleDiff(args, parsed.options);
      return;
    case "exec":
      await handleExec(args, parsed.options);
      return;
    case "approve":
    case "reject":
    case "revise":
      await handleApprovalCommand(command, args, parsed.options);
      return;
    case "approvals":
      await handleApprovals(args, parsed.options);
      return;
    case "continue":
      await handleContinue(args, parsed.options);
      return;
    case "loop":
      await handleLoop(args, parsed.options);
      return;
    case "reconcile":
      await handleReconcile(args, parsed.options);
      return;
    case "summon":
      await handleSummon(args, parsed.options);
      return;
    case "fanout":
      await handleFanout(args, parsed.options);
      return;
    case "transfer":
      await handleTransfer(args, parsed.options);
      return;
    case "abort":
      await handleAbort(args, parsed.options);
      return;
    case "browser":
      await handleBrowser(args, parsed.options);
      return;
    case "ui":
      await handleUi(args, parsed.options);
      return;
    case "mcp":
      await handleMcp(args, parsed.options);
      return;
    default:
      throw new InputError(`Unknown command "${command}". Run "thehood help".`);
  }
};

runCli(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof TheHoodError) {
    process.stderr.write(`thehood: ${error.message}\n`);
    process.exit(error.exitCode);
  }

  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`thehood: unexpected error\n${message}\n`);
  process.exit(1);
});
