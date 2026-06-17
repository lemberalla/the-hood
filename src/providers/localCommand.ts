import { spawn } from "node:child_process";
import { ProviderUnavailableError } from "../runtime/errors.js";
import { redactText } from "../runtime/redaction.js";
import type { AgentRequest, AgentResponse, ProviderAdapter } from "./types.js";
import type { JsonObject, JsonValue, RuntimeRole } from "../runtime/types.js";

export interface LocalAgentCommandSpec {
  providerId: string;
  command: string;
  args: string[];
  timeoutMs?: number;
}

export interface FallbackResponseInput {
  status: AgentResponse["status"];
  summary: string;
  exitCode?: number;
  stdoutLength?: number;
  stderrLength?: number;
}

const defaultTimeoutMs = 10 * 60 * 1000;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isAgentResponse = (value: unknown): value is AgentResponse => {
  if (!isObject(value)) {
    return false;
  }

  return (
    (value.status === "ok" || value.status === "blocked" || value.status === "failed") &&
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

const unwrapProviderResult = (value: unknown): unknown => {
  if (!isObject(value)) {
    return value;
  }

  if (isAgentResponse(value)) {
    return value;
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
      [requiredDataKey]: payload as JsonValue
    }
  };
};

export const buildAgentPrompt = (request: AgentRequest): string => {
  const requiredDataKey = request.directive.outputContract.requiredDataKey;
  const responseEnvelope = {
    status: "ok | blocked | failed",
    summary: "short human-readable summary",
    data: {
      [requiredDataKey]: {
        "...": "role-specific object matching the directive output contract"
      }
    }
  };

  return [
    "You are a provider adapter worker for TheHood.",
    "Follow the runtime directive exactly. Do not reveal hidden reasoning.",
    "Return only a JSON object. Do not wrap it in Markdown.",
    "The JSON object must match this envelope:",
    JSON.stringify(responseEnvelope, null, 2),
    "Runtime directive:",
    JSON.stringify(request.directive, null, 2)
  ].join("\n\n");
};

export const runLocalAgentCommand = async (
  request: AgentRequest,
  spec: LocalAgentCommandSpec
): Promise<AgentResponse> => {
  const prompt = buildAgentPrompt(request);
  const timeoutMs = spec.timeoutMs ?? defaultTimeoutMs;
  const child = spawn(spec.command, spec.args, {
    cwd: request.run.repoPath,
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

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  }).catch((error: NodeJS.ErrnoException) => {
    clearTimeout(timer);

    if (error.code === "ENOENT") {
      throw new ProviderUnavailableError(
        `${spec.providerId} command "${spec.command}" was not found on PATH.`
      );
    }

    throw error;
  });

  clearTimeout(timer);

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  const redactedStdout = redactText(stdout);
  const redactedStderr = redactText(stderr);

  if (timedOut) {
    return createFallbackAgentResponse(request, {
      status: "failed",
      summary: `${spec.providerId} timed out after ${timeoutMs}ms.`,
      exitCode,
      stdoutLength: redactedStdout.length,
      stderrLength: redactedStderr.length
    });
  }

  if (exitCode !== 0) {
    return createFallbackAgentResponse(request, {
      status: "failed",
      summary: `${spec.providerId} exited with code ${exitCode}.`,
      exitCode,
      stdoutLength: redactedStdout.length,
      stderrLength: redactedStderr.length
    });
  }

  return (
    parseLocalAgentOutput(redactedStdout) ??
    createFallbackAgentResponse(request, {
      status: "blocked",
      summary: `${spec.providerId} returned output that did not match the AgentResponse envelope.`,
      exitCode,
      stdoutLength: redactedStdout.length,
      stderrLength: redactedStderr.length
    })
  );
};

export const createLocalCommandProvider = (
  id: string,
  command: string,
  buildArgs: (request: AgentRequest) => string[]
): ProviderAdapter => ({
  id,
  async runAgent(request) {
    return runLocalAgentCommand(request, {
      providerId: id,
      command,
      args: buildArgs(request)
    });
  }
});
