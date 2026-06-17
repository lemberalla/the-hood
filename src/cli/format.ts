import { formatRoleAssignment } from "../runtime/role-assignment.js";
import type { AdvanceRunResult } from "../runtime/loop.js";
import type { RunCommandResult } from "../runtime/commandRunner.js";
import type { GitEvidenceResult } from "../runtime/gitEvidence.js";
import type { ProviderDescriptor } from "../runtime/providers.js";
import type { RoleMap, RunRecord, TheHoodConfig } from "../runtime/types.js";

export const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

export const formatRoles = (roles: RoleMap): string =>
  Object.entries(roles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, assignment]) => `${role}: ${formatRoleAssignment(assignment)}`)
    .join("\n");

export const formatProviders = (providers: ProviderDescriptor[]): string =>
  providers
    .map((provider) => {
      const state = provider.enabled ? "enabled" : "disabled";
      return `${provider.id} (${state}): ${provider.models.join(", ")}`;
    })
    .join("\n");

export const formatConfig = (config: TheHoodConfig): string => [
  "defaults:",
  `  maxIterations: ${config.defaults.maxIterations}`,
  `  editRequiresApproval: ${config.defaults.editRequiresApproval}`,
  `  networkRequiresApproval: ${config.defaults.networkRequiresApproval}`,
  "",
  "roles:",
  formatRoles(config.roles)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
].join("\n");

export const formatRunSummary = (run: RunRecord): string => {
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
      .join("\n")
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
  run.events
    .map((event) => `${event.createdAt}  ${event.type}  ${event.message}`)
    .join("\n");

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
