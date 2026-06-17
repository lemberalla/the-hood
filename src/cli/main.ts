#!/usr/bin/env node
import { initConfig, loadConfig, writeConfig } from "../runtime/config.js";
import { runRuntimeCommand } from "../runtime/commandRunner.js";
import { inspectRuntimeHealth } from "../runtime/doctor.js";
import { InputError, TheHoodError } from "../runtime/errors.js";
import { captureGitEvidence } from "../runtime/gitEvidence.js";
import { advanceRun } from "../runtime/loop.js";
import { startMcpServer } from "../mcp/server.js";
import { listProviders } from "../runtime/providers.js";
import { parseRole, parseRoleAssignment } from "../runtime/role-assignment.js";
import {
  abortRun,
  createRun,
  getRun,
  listRuns,
  recordApproval
} from "../runtime/runtime.js";
import { approvalDecisions, runModes, type ApprovalDecision, type RoleMap, type RunMode } from "../runtime/types.js";
import {
  getBooleanOption,
  getStringListOption,
  getStringOption,
  parseArgs,
  type CliOptionValue
} from "./args.js";
import {
  formatConfig,
  formatAdvanceRunResult,
  formatCommandResult,
  formatDoctorReport,
  formatGitEvidence,
  formatProviders,
  formatRoles,
  formatRunEvents,
  formatRunList,
  formatRunSummary,
  printJson
} from "./format.js";

const helpText = `TheHood local agent runtime

Usage:
  thehood init [--repo <path>]
  thehood config show [--repo <path>] [--json]
  thehood providers [--repo <path>] [--json]
  thehood doctor [--repo <path>] [--json]
  thehood models [--repo <path>] [--json]
  thehood roles [--repo <path>] [--json]
  thehood roles set <role> <provider:model> [--repo <path>]
  thehood plan <goal> [--repo <path>] [--json]
  thehood run <goal> [--repo <path>] [--mode <mode>] [--json]
  thehood status [run-id] [--repo <path>] [--json]
  thehood logs <run-id> [--repo <path>] [--json]
  thehood evidence <run-id> [--repo <path>] [--json]
  thehood exec <run-id> [--repo <path>] [--cwd <path>] [--allow-risky] -- <command> [args...]
  thehood approve <run-id> [--repo <path>] [--reason <text>]
  thehood reject <run-id> [--repo <path>] [--reason <text>]
  thehood continue <run-id> [--repo <path>] [--json]
  thehood abort <run-id> [--repo <path>] [--reason <text>]
  thehood mcp

Role override options for plan/run:
  --orchestrator provider:model
  --planner provider:model
  --researcher provider:model
  --implementer provider:model
  --verifier provider:model
  --critic provider:model
  --constraint "text"
`;

const repoFromOptions = (options: Record<string, CliOptionValue>): string =>
  getStringOption(options, "repo") ?? process.cwd();

const shouldPrintJson = (options: Record<string, CliOptionValue>): boolean =>
  getBooleanOption(options, "json");

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

  for (const role of ["orchestrator", "planner", "researcher", "implementer", "verifier", "critic"] as const) {
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

const ensureRunId = (value: string | undefined): string => {
  if (!value) {
    throw new InputError("Run id is required.");
  }

  return value;
};

const handleInit = async (options: Record<string, CliOptionValue>): Promise<void> => {
  const result = await initConfig(repoFromOptions(options));

  if (shouldPrintJson(options)) {
    printJson(result);
    return;
  }

  process.stdout.write(
    `${result.created ? "Created" : "Found existing"} config: ${result.configPath}\n`
  );
};

const handleConfig = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const subcommand = args[0] ?? "show";

  if (subcommand !== "show") {
    throw new InputError(`Unknown config subcommand "${subcommand}".`);
  }

  const config = await loadConfig(repoFromOptions(options));
  shouldPrintJson(options) ? printJson(config) : process.stdout.write(`${formatConfig(config)}\n`);
};

const handleProviders = async (options: Record<string, CliOptionValue>): Promise<void> => {
  const config = await loadConfig(repoFromOptions(options));
  const providers = listProviders(config);
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

    await writeConfig(repoPath, updated);
    process.stdout.write(`${role}: ${assignment.provider}:${assignment.model}\n`);
    return;
  }

  shouldPrintJson(options) ? printJson(config.roles) : process.stdout.write(`${formatRoles(config.roles)}\n`);
};

const handleCreateRun = async (
  command: "plan" | "run",
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const goal = args.join(" ").trim();
  const mode = command === "plan" ? "plan" : parseMode(getStringOption(options, "mode"), "implement");
  const run = await createRun({
    repoPath: repoFromOptions(options),
    goal,
    mode,
    roleOverrides: parseRoleOverrides(options),
    constraints: getStringListOption(options, "constraint")
  });

  shouldPrintJson(options) ? printJson(run) : process.stdout.write(`${formatRunSummary(run)}\n`);
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
  shouldPrintJson(options) ? printJson(run) : process.stdout.write(`${formatRunSummary(run)}\n`);
};

const handleLogs = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const run = await getRun(repoFromOptions(options), ensureRunId(args[0]));
  shouldPrintJson(options) ? printJson(run.events) : process.stdout.write(`${formatRunEvents(run)}\n`);
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
  command: "approve" | "reject",
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const decision = parseDecision(command);
  const reason = getStringOption(options, "reason") ?? `${command} requested from CLI`;
  const run = await recordApproval(repoFromOptions(options), ensureRunId(args[0]), decision, reason);
  shouldPrintJson(options) ? printJson(run) : process.stdout.write(`${formatRunSummary(run)}\n`);
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

const handleAbort = async (
  args: string[],
  options: Record<string, CliOptionValue>
): Promise<void> => {
  const reason = getStringOption(options, "reason") ?? "Aborted from CLI.";
  const run = await abortRun(repoFromOptions(options), ensureRunId(args[0]), reason);
  shouldPrintJson(options) ? printJson(run) : process.stdout.write(`${formatRunSummary(run)}\n`);
};

const handleMcp = async (): Promise<void> => {
  await startMcpServer();
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
    case "roles":
      await handleRoles(args, parsed.options);
      return;
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
    case "evidence":
      await handleEvidence(args, parsed.options);
      return;
    case "exec":
      await handleExec(args, parsed.options);
      return;
    case "approve":
    case "reject":
      await handleApprovalCommand(command, args, parsed.options);
      return;
    case "continue":
      await handleContinue(args, parsed.options);
      return;
    case "abort":
      await handleAbort(args, parsed.options);
      return;
    case "mcp":
      await handleMcp();
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
