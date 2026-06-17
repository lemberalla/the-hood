import { spawn } from "node:child_process";
import path from "node:path";
import { writeRunArtifact } from "./artifacts.js";
import { classifyCommand } from "./commandSafety.js";
import { ApprovalRequiredError, InputError } from "./errors.js";
import { newId, nowIso } from "./ids.js";
import { resolveRepoPath } from "./paths.js";
import { redactText } from "./redaction.js";
import { loadRun, saveRun } from "./store.js";
import type { RunArtifact, RunRecord, ToolEvent } from "./types.js";

export interface RunCommandInput {
  repoPath: string;
  runId: string;
  command: string;
  args: string[];
  cwd?: string;
  tool?: string;
  allowRisky?: boolean;
}

export interface RunCommandResult {
  run: RunRecord;
  event: ToolEvent;
  artifacts: RunArtifact[];
  stdout: string;
  stderr: string;
}

const resolveCommandCwd = (repoPath: string, cwd: string | undefined): string => {
  const root = resolveRepoPath(repoPath);
  const resolved = path.resolve(root, cwd ?? ".");
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new InputError(`Command cwd must stay inside repo path: ${resolved}`);
  }

  return resolved;
};

const commandLabel = (command: string, args: string[]): string =>
  [command, ...args].join(" ");

const artifactBaseName = (tool: string, id: string, extension: string): string =>
  `${tool}-${id}.${extension}`;

export const runRuntimeCommand = async (input: RunCommandInput): Promise<RunCommandResult> => {
  const command = input.command.trim();

  if (!command) {
    throw new InputError("Command cannot be empty.");
  }

  const repoPath = resolveRepoPath(input.repoPath);
  const cwd = resolveCommandCwd(repoPath, input.cwd);
  const run = await loadRun(repoPath, input.runId);
  const safety = classifyCommand(command, input.args);

  if (safety.requiresApproval && !input.allowRisky) {
    throw new ApprovalRequiredError(
      `${commandLabel(command, input.args)} requires approval: ${safety.reason ?? "risky command"}`
    );
  }

  const startedAt = Date.now();
  const child = spawn(command, input.args, {
    cwd,
    shell: false,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  const durationMs = Date.now() - startedAt;
  const stdout = redactText(Buffer.concat(stdoutChunks).toString("utf8"));
  const stderr = redactText(Buffer.concat(stderrChunks).toString("utf8"));
  const eventId = newId("tool");
  const tool = input.tool ?? command;
  const artifacts: RunArtifact[] = [];

  const stdoutArtifact = await writeRunArtifact({
    repoPath,
    runId: input.runId,
    kind: "log",
    name: artifactBaseName(tool, eventId, "stdout.txt"),
    content: stdout,
    summary: `stdout for ${commandLabel(command, input.args)}`
  });
  artifacts.push(stdoutArtifact);

  const stderrArtifact = await writeRunArtifact({
    repoPath,
    runId: input.runId,
    kind: "log",
    name: artifactBaseName(tool, eventId, "stderr.txt"),
    content: stderr,
    summary: `stderr for ${commandLabel(command, input.args)}`
  });
  artifacts.push(stderrArtifact);

  const event: ToolEvent = {
    id: eventId,
    createdAt: nowIso(),
    tool,
    command,
    args: input.args,
    cwd,
    exitCode,
    durationMs,
    safetyCategory: safety.category,
    permissionDecision: safety.requiresApproval ? "allowed_explicit_user" : "allowed",
    stdoutRef: stdoutArtifact.ref,
    stderrRef: stderrArtifact.ref
  };

  const updated: RunRecord = {
    ...run,
    updatedAt: nowIso(),
    artifacts: [...run.artifacts, ...artifacts],
    toolEvents: [...run.toolEvents, event],
    events: [
      ...run.events,
      {
        id: newId("event"),
        createdAt: nowIso(),
        type: "command_executed",
        message: `${commandLabel(command, input.args)} exited with ${exitCode}.`,
        data: {
          tool,
          exitCode,
          safetyCategory: safety.category
        }
      }
    ]
  };

  await saveRun(updated);

  return {
    run: updated,
    event,
    artifacts,
    stdout,
    stderr
  };
};
