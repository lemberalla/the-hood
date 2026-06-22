import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeRunArtifact } from "../runtime/artifacts.js";
import { ProviderUnavailableError } from "../runtime/errors.js";
import { newId, nowIso } from "../runtime/ids.js";
import { markProviderWaitPosted } from "../runtime/providerWaits.js";
import { redactText } from "../runtime/redaction.js";
import { loadRun, saveRun } from "../runtime/store.js";
import { agentMarkdownField } from "./markdownPayload.js";
import { buildAgentResponseSchema } from "./responseSchema.js";
import type { AgentRequest, AgentResponse, ProviderAdapter } from "./types.js";
import type { JsonObject, JsonValue, ProviderWaitTarget, RunArtifact, RuntimeRole } from "../runtime/types.js";

export interface LocalAgentCommandSpec {
  providerId: string;
  command: string;
  buildArgs: BuildLocalAgentArgs;
  timeoutMs?: number;
}

export interface LocalAgentCommandContext {
  schema: JsonObject;
  schemaPath: string;
  workspacePath: string;
}

export type BuildLocalAgentArgs = (request: AgentRequest, context: LocalAgentCommandContext) => string[];

export interface FallbackResponseInput {
  status: AgentResponse["status"];
  summary: string;
  exitCode?: number;
  stdoutLength?: number;
  stderrLength?: number;
}

const defaultTimeoutMs = 10 * 60 * 1000;

const directEditAllowed = (): boolean => process.env.THEHOOD_ALLOW_DIRECT_EDIT === "1";

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface LocalWorkspace {
  path: string;
  mode: "target_checkout" | "isolated_git_worktree";
  cleanup: () => Promise<void>;
}

interface LocalAgentExecutionArtifactInput {
  request: AgentRequest;
  spec: LocalAgentCommandSpec;
  workspace: LocalWorkspace;
  args: string[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutLength: number;
  stderrLength: number;
  responseParsed: boolean;
  responseStatus: AgentResponse["status"];
  patchArtifact?: RunArtifact;
}

const runProcess = async (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ProcessResult> => {
  const child = spawn(command, args, {
    cwd,
    shell: false,
    env,
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

  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8")
  };
};

const targetCheckoutWorkspace = (repoPath: string): LocalWorkspace => ({
  path: repoPath,
  mode: "target_checkout",
  cleanup: async () => {
    // Target checkout cleanup is owned by the runtime/user.
  }
});

const prepareIsolatedWorktree = async (request: AgentRequest): Promise<LocalWorkspace | AgentResponse> => {
  const status = await runProcess(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).thehood"],
    request.run.repoPath
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new ProviderUnavailableError("git command was not found on PATH.");
    }

    throw error;
  });

  if (status.exitCode !== 0) {
    return createFallbackAgentResponse(request, {
      status: "blocked",
      summary: "Isolated edit-capable local agent execution requires a git repository."
    });
  }

  if (status.stdout.trim()) {
    return createFallbackAgentResponse(request, {
      status: "blocked",
      summary: "Isolated edit-capable local agent execution requires a clean target checkout."
    });
  }

  const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), `thehood-${request.run.runId}-${request.role}-`));
  const added = await runProcess("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], request.run.repoPath);

  if (added.exitCode !== 0) {
    await fs.rm(worktreePath, { recursive: true, force: true });
    return createFallbackAgentResponse(request, {
      status: "blocked",
      summary: "Could not create isolated git worktree for edit-capable local agent execution.",
      exitCode: added.exitCode,
      stdoutLength: redactText(added.stdout).length,
      stderrLength: redactText(added.stderr).length
    });
  }

  return {
    path: worktreePath,
    mode: "isolated_git_worktree",
    cleanup: async () => {
      await runProcess("git", ["worktree", "remove", "--force", worktreePath], request.run.repoPath).catch(() => ({
        exitCode: 1,
        stdout: "",
        stderr: ""
      }));
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  };
};

const prepareWorkspace = async (request: AgentRequest): Promise<LocalWorkspace | AgentResponse> => {
  if (!request.directive.toolPermissions.edit || directEditAllowed()) {
    return targetCheckoutWorkspace(request.run.repoPath);
  }

  return prepareIsolatedWorktree(request);
};

const writeSchemaFile = async (providerId: string, schema: JsonObject): Promise<{ dir: string; path: string }> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `thehood-${providerId}-schema-`));
  const schemaPath = path.join(dir, "agent-response.schema.json");

  await fs.writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  return {
    dir,
    path: schemaPath
  };
};

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isAgentResponseStatus = (value: unknown): value is AgentResponse["status"] =>
  value === "ok" || value === "blocked" || value === "failed";

const isAgentResponse = (value: unknown): value is AgentResponse => {
  if (!isObject(value)) {
    return false;
  }

  return (
    isAgentResponseStatus(value.status) &&
    typeof value.summary === "string" &&
    isObject(value.data)
  );
};

const tryParseJson = (value: string): unknown | undefined => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const parseJsonCandidate = (text: string): unknown | undefined => {
  const trimmed = text.trim();

  if (!trimmed) {
    return undefined;
  }

  const exact = tryParseJson(trimmed);
  if (exact !== undefined) {
    return exact;
  }

  const lineCandidate = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .map(tryParseJson)
    .find((value) => value !== undefined);

  if (lineCandidate !== undefined) {
    return lineCandidate;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return tryParseJson(trimmed.slice(start, end + 1));
  }

  return undefined;
};

const unwrapStructuredOutput = (value: JsonObject): unknown | undefined => {
  const structuredOutput = value.structured_output ?? value.structuredOutput;

  if (typeof structuredOutput === "string") {
    const parsed = parseJsonCandidate(structuredOutput);
    return isAgentResponse(parsed) ? parsed : undefined;
  }

  if (!isObject(structuredOutput)) {
    return undefined;
  }

  if (isAgentResponse(structuredOutput)) {
    return structuredOutput;
  }

  if (
    isAgentResponseStatus(value.status) &&
    typeof value.summary === "string" &&
    isObject(structuredOutput.data)
  ) {
    return {
      status: value.status,
      summary: value.summary,
      data: structuredOutput.data
    };
  }

  return undefined;
};

const unwrapProviderResult = (value: unknown): unknown => {
  if (!isObject(value)) {
    return value;
  }

  if (isAgentResponse(value)) {
    return value;
  }

  const structuredOutput = unwrapStructuredOutput(value);
  if (structuredOutput !== undefined) {
    return structuredOutput;
  }

  const result = value.result;
  if (typeof result === "string") {
    return parseJsonCandidate(result) ?? value;
  }

  if (isObject(result)) {
    return result;
  }

  const message = value.message;
  if (typeof message === "string") {
    return parseJsonCandidate(message) ?? value;
  }

  return value;
};

export const parseLocalAgentOutput = (stdout: string): AgentResponse | undefined => {
  const parsed = parseJsonCandidate(stdout);
  const unwrapped = unwrapProviderResult(parsed);

  return isAgentResponse(unwrapped) ? unwrapped : undefined;
};

const isFallbackResponse = (value: LocalWorkspace | AgentResponse): value is AgentResponse =>
  "status" in value && "summary" in value && "data" in value;

const roleFallbackPayload = (
  role: RuntimeRole,
  requiredDataKey: string,
  summary: string,
  responseStatus: AgentResponse["status"],
  processMetadata: JsonObject
): JsonObject => {
  switch (role) {
    case "orchestrator":
    case "planner":
      return {
        action: "request_approval",
        reason: summary,
        process: processMetadata
      };
    case "implementer":
      return {
        status: responseStatus === "blocked" ? "blocked" : "failed",
        changedFiles: [],
        commandsRun: [],
        unresolvedRisks: [summary],
        process: processMetadata
      };
    case "qa":
      return {
        verdict: responseStatus === "blocked" ? "blocked" : "needs_more_evidence",
        summary,
        suggestedCommands: [],
        risks: [summary],
        process: processMetadata
      };
    case "verifier":
      return {
        verdict: "ask_user",
        summary,
        failedCriteria: ["provider_response"],
        risks: [summary],
        nextAction: "user",
        process: processMetadata
      };
    case "critic":
      return {
        verdict: "unclear",
        blockingConcerns: [summary],
        nonBlockingConcerns: [],
        process: processMetadata
      };
    default:
      return {
        status: "blocked",
        summary,
        process: processMetadata,
        requiredDataKey
      };
  }
};

const directiveAckJson = (request: Pick<AgentRequest, "directive">): JsonObject => ({
  runId: request.directive.directiveAck.runId,
  nonce: request.directive.directiveAck.nonce,
  responseField: request.directive.directiveAck.responseField
});

export const createFallbackAgentResponse = (
  request: Pick<AgentRequest, "role" | "directive">,
  input: FallbackResponseInput
): AgentResponse => {
  const requiredDataKey = request.directive.outputContract.requiredDataKey;
  const processMetadata: JsonObject = {
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.stdoutLength === undefined ? {} : { stdoutLength: input.stdoutLength }),
    ...(input.stderrLength === undefined ? {} : { stderrLength: input.stderrLength })
  };
  const payload = roleFallbackPayload(request.role, requiredDataKey, input.summary, input.status, processMetadata);

  return {
    status: input.status,
    summary: input.summary,
    data: {
      [requiredDataKey]: {
        ...payload,
        thehoodDirectiveAck: directiveAckJson(request)
      }
    }
  };
};

export const buildAgentPrompt = (request: AgentRequest): string => {
  const requiredDataKey = request.directive.outputContract.requiredDataKey;
  const schema = buildAgentResponseSchema(request);
  const responseEnvelope = {
    status: "ok | blocked | failed",
    summary: "short human-readable summary",
    data: {
      [requiredDataKey]: {
        "...": "role-specific object matching the directive output contract",
        [agentMarkdownField]: "optional GitHub-flavored Markdown string for plans, reports, reviews, or rationale",
        thehoodDirectiveAck: directiveAckJson(request)
      }
    }
  };

  return [
    "You are a provider adapter worker for TheHood.",
    "Follow the runtime directive exactly. Do not reveal hidden reasoning.",
    "Return only a JSON object. Do not wrap the response itself in Markdown.",
    `For long human-facing content, use data.${requiredDataKey}.${agentMarkdownField} as a JSON string containing GitHub-flavored Markdown.`,
    "Keep mechanical control fields such as action, verdict, status, refs, and directive acknowledgement outside the markdown string.",
    "Do not encode long plans, reports, reviews, or rationale as deep nested JSON objects or arrays.",
    "The JSON object must match this envelope:",
    JSON.stringify(responseEnvelope, null, 2),
    "The JSON object must satisfy this exact JSON Schema:",
    JSON.stringify(schema, null, 2),
    `The role payload is data.${requiredDataKey}. Use the schema property names literally.`,
    `Echo directiveAck exactly as data.${requiredDataKey}.thehoodDirectiveAck so TheHood can reject stale provider-session responses.`,
    "Do not replace required schema fields with synonyms such as nextAction, next_action, rationale, or verdictSummary.",
    "Runtime directive:",
    JSON.stringify(request.directive, null, 2)
  ].join("\n\n");
};

const attachArtifact = async (
  request: AgentRequest,
  artifact: RunArtifact,
  workspace: LocalWorkspace,
  changedPathCount: number
): Promise<void> => {
  const latest = await loadRun(request.run.repoPath, request.run.runId);
  await saveRun({
    ...latest,
    updatedAt: nowIso(),
    artifacts: [...latest.artifacts, artifact],
    events: [
      ...latest.events,
      {
        id: newId("event"),
        createdAt: nowIso(),
        type: "isolated_patch_captured",
        message: `Captured isolated ${request.role} patch for ${changedPathCount} changed path(s).`,
        data: {
          role: request.role,
          provider: request.assignment.provider,
          workspaceMode: workspace.mode,
          changedPathCount,
          artifactRef: artifact.ref
        }
      }
    ]
  });
};

const captureIsolatedPatch = async (
  request: AgentRequest,
  workspace: LocalWorkspace
): Promise<RunArtifact | undefined> => {
  if (workspace.mode !== "isolated_git_worktree") {
    return undefined;
  }

  const status = await runProcess("git", ["status", "--short", "--untracked-files=all"], workspace.path);
  const statusText = redactText(status.stdout);

  if (!statusText.trim()) {
    return undefined;
  }

  await runProcess("git", ["add", "-N", "."], workspace.path);
  const diff = await runProcess("git", ["diff", "--no-ext-diff", "--binary"], workspace.path);
  const patch = redactText(diff.stdout);
  const changedPaths = statusText
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  const artifact = await writeRunArtifact({
    repoPath: request.run.repoPath,
    runId: request.run.runId,
    kind: "diff",
    name: `${request.role}-${request.assignment.provider}-${newId("patch")}.patch`,
    content: [
      `# Isolated workspace mode: ${workspace.mode}`,
      "# Changed paths:",
      ...changedPaths.map((changedPath) => `# - ${changedPath}`),
      "",
      patch
    ].join("\n"),
    summary: `Isolated ${request.role} patch from ${request.assignment.provider} with ${changedPaths.length} changed path(s).`
  });

  await attachArtifact(request, artifact, workspace, changedPaths.length);
  return artifact;
};

const withPatchArtifact = (
  request: AgentRequest,
  response: AgentResponse,
  patchArtifact: RunArtifact | undefined,
  workspace: LocalWorkspace
): AgentResponse => {
  if (!patchArtifact || request.role !== "implementer") {
    return response;
  }

  const requiredDataKey = request.directive.outputContract.requiredDataKey;
  const payload = response.data[requiredDataKey];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return response;
  }

  return {
    ...response,
    data: {
      ...response.data,
      [requiredDataKey]: {
        ...payload,
        isolatedWorkspace: {
          mode: workspace.mode
        },
        patchArtifact: {
          kind: patchArtifact.kind,
          ref: patchArtifact.ref,
          summary: patchArtifact.summary
        }
      } as JsonValue
    }
  };
};

const commandMode = (request: AgentRequest): string =>
  request.directive.toolPermissions.edit ? "edit-capable" : "read-only";

const commandOption = (args: string[], option: string): string | undefined => {
  const optionIndex = args.indexOf(option);

  return optionIndex >= 0 ? args[optionIndex + 1] : undefined;
};

const providerWaitPathOptionLabels = new Map([
  ["--cd", "[cwd]"],
  ["--schema", "[schema-path]"],
  ["--output-schema", "[schema-path]"]
]);

const providerWaitArg = (args: string[], index: number): string => {
  const replacement = providerWaitPathOptionLabels.get(args[index - 1] ?? "");

  return replacement ?? redactText(args[index] ?? "");
};

const providerWaitTarget = (
  request: AgentRequest,
  spec: LocalAgentCommandSpec,
  workspace: LocalWorkspace,
  args: string[]
): ProviderWaitTarget => ({
  kind: "local_command",
  label: `${spec.providerId} command for ${request.role}`,
  command: path.basename(spec.command),
  workspaceMode: workspace.mode,
  args: args.map((_arg, index) => providerWaitArg(args, index))
});

const writeLocalAgentExecutionArtifact = async (
  input: LocalAgentExecutionArtifactInput
): Promise<RunArtifact> => {
  const sandbox = commandOption(input.args, "--sandbox");
  const permissionMode = commandOption(input.args, "--permission-mode");
  const summary = `${input.request.role} local agent ${input.spec.providerId}:${input.request.assignment.model} exited ${input.exitCode}.`;
  const logBaseName = `${input.request.role}-${input.spec.providerId}-${newId("local-agent-output")}`;
  const stdoutArtifact = await writeRunArtifact({
    repoPath: input.request.run.repoPath,
    runId: input.request.run.runId,
    kind: "log",
    name: `${logBaseName}.stdout.txt`,
    content: input.stdout,
    summary: `stdout for ${input.request.role} local agent ${input.spec.providerId}:${input.request.assignment.model}`
  });
  const stderrArtifact = await writeRunArtifact({
    repoPath: input.request.run.repoPath,
    runId: input.request.run.runId,
    kind: "log",
    name: `${logBaseName}.stderr.txt`,
    content: input.stderr,
    summary: `stderr for ${input.request.role} local agent ${input.spec.providerId}:${input.request.assignment.model}`
  });
  const payload: JsonObject = {
    schemaVersion: 1,
    kind: "local_agent_execution",
    runId: input.request.run.runId,
    role: input.request.role,
    provider: input.spec.providerId,
    model: input.request.assignment.model,
    command: input.spec.command,
    args: input.args.map(redactText),
    commandMode: commandMode(input.request),
    workspaceMode: input.workspace.mode,
    ...(sandbox ? { sandbox } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    toolPermissions: input.request.directive.toolPermissions as unknown as JsonObject,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    timeoutMs: input.spec.timeoutMs ?? defaultTimeoutMs,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    stdoutLength: input.stdoutLength,
    stderrLength: input.stderrLength,
    stdoutRef: stdoutArtifact.ref,
    stderrRef: stderrArtifact.ref,
    responseParsed: input.responseParsed,
    responseStatus: input.responseStatus,
    ...(input.patchArtifact
      ? {
          patchArtifact: {
            kind: input.patchArtifact.kind,
            ref: input.patchArtifact.ref,
            summary: input.patchArtifact.summary
          }
        }
      : {})
  };
  const artifact = await writeRunArtifact({
    repoPath: input.request.run.repoPath,
    runId: input.request.run.runId,
    kind: "provider_invocation",
    name: `${input.request.role}-${input.spec.providerId}-${newId("provider-invocation")}.json`,
    content: `${JSON.stringify(payload, null, 2)}\n`,
    summary
  });
  const latest = await loadRun(input.request.run.repoPath, input.request.run.runId);

  await saveRun({
    ...latest,
    updatedAt: nowIso(),
    artifacts: [...latest.artifacts, stdoutArtifact, stderrArtifact, artifact],
    events: [
      ...latest.events,
      {
        id: newId("event"),
        createdAt: nowIso(),
        type: "local_agent_command_completed",
        message: summary,
        data: {
          role: input.request.role,
          provider: input.spec.providerId,
          model: input.request.assignment.model,
          command: input.spec.command,
          workspaceMode: input.workspace.mode,
          commandMode: commandMode(input.request),
          ...(sandbox ? { sandbox } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          exitCode: input.exitCode,
          timedOut: input.timedOut,
          durationMs: input.durationMs,
          responseParsed: input.responseParsed,
          responseStatus: input.responseStatus,
          stdoutRef: stdoutArtifact.ref,
          stderrRef: stderrArtifact.ref,
          artifactRef: artifact.ref
        }
      }
    ]
  });

  return artifact;
};

export const runLocalAgentCommand = async (
  request: AgentRequest,
  spec: LocalAgentCommandSpec
): Promise<AgentResponse> => {
  const workspace = await prepareWorkspace(request);

  if (isFallbackResponse(workspace)) {
    return workspace;
  }

  const prompt = buildAgentPrompt(request);
  const timeoutMs = spec.timeoutMs ?? defaultTimeoutMs;
  const schema = buildAgentResponseSchema(request);
  const schemaFile = await writeSchemaFile(spec.providerId, schema);
  const args = spec.buildArgs(request, {
    schema,
    schemaPath: schemaFile.path,
    workspacePath: workspace.path
  });
  const startedAt = nowIso();
  const startedMs = Date.now();
  const child = spawn(spec.command, args, {
    cwd: workspace.path,
    shell: false,
    env: {
      ...process.env,
      THEHOOD_RUN_ID: request.run.runId,
      THEHOOD_ROLE: request.role,
      THEHOOD_PROVIDER: spec.providerId
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  child.stdin.end(prompt);
  await markProviderWaitPosted({
    run: request.run,
    role: request.role,
    assignment: request.assignment,
    directive: request.directive,
    target: providerWaitTarget(request, spec, workspace, args)
  });

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    }).catch(async (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      await fs.rm(schemaFile.dir, { recursive: true, force: true });

      if (error.code === "ENOENT") {
        throw new ProviderUnavailableError(
          `${spec.providerId} command "${spec.command}" was not found on PATH.`
        );
      }

      throw error;
    });

    clearTimeout(timer);
    await fs.rm(schemaFile.dir, { recursive: true, force: true });

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    const redactedStdout = redactText(stdout);
    const redactedStderr = redactText(stderr);
    const patchArtifact = await captureIsolatedPatch(request, workspace);
    const parsedResponse = !timedOut && exitCode === 0
      ? parseLocalAgentOutput(redactedStdout)
      : undefined;
    const response = timedOut
      ? createFallbackAgentResponse(request, {
        status: "failed",
        summary: `${spec.providerId} timed out after ${timeoutMs}ms.`,
        exitCode,
        stdoutLength: redactedStdout.length,
        stderrLength: redactedStderr.length
      })
      : exitCode !== 0
        ? createFallbackAgentResponse(request, {
        status: "failed",
        summary: `${spec.providerId} exited with code ${exitCode}.`,
        exitCode,
        stdoutLength: redactedStdout.length,
        stderrLength: redactedStderr.length
      })
        : parsedResponse ??
          createFallbackAgentResponse(request, {
            status: "blocked",
            summary: `${spec.providerId} returned output that did not match the AgentResponse envelope.`,
            exitCode,
            stdoutLength: redactedStdout.length,
            stderrLength: redactedStderr.length
          });
    const responseWithPatch = withPatchArtifact(request, response, patchArtifact, workspace);

    await writeLocalAgentExecutionArtifact({
      request,
      spec,
      workspace,
      args,
      startedAt,
      completedAt: nowIso(),
      durationMs: Date.now() - startedMs,
      exitCode,
      timedOut,
      stdoutLength: redactedStdout.length,
      stderrLength: redactedStderr.length,
      stdout: redactedStdout,
      stderr: redactedStderr,
      responseParsed: Boolean(parsedResponse),
      responseStatus: responseWithPatch.status,
      ...(patchArtifact ? { patchArtifact } : {})
    });

    return responseWithPatch;
  } finally {
    clearTimeout(timer);
    await fs.rm(schemaFile.dir, { recursive: true, force: true });
    await workspace.cleanup();
  }
};

export const createLocalCommandProvider = (
  id: string,
  command: string,
  buildArgs: BuildLocalAgentArgs
): ProviderAdapter => ({
  id,
  async runAgent(request) {
    return runLocalAgentCommand(request, {
      providerId: id,
      command,
      buildArgs
    });
  }
});
