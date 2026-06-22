#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import type { AgentResponse } from "../providers/types.js";
import type { JsonObject } from "../runtime/types.js";

type AtlasTransport = "computer-use" | "fake";

interface BridgeOptions {
  model: string;
  schemaPath: string;
  target: string;
  transport: AtlasTransport;
  timeoutMs: number;
  commandTimeoutMs: number;
  allowUnverifiedTarget: boolean;
  computerUseCommand?: string;
  fakeResponse?: string;
  fakeResponseFile?: string;
}

interface ExpectedDirectiveAck {
  runId: string;
  nonce: string;
  responseField: string;
}

interface AtlasModelSelection {
  requestedModel: string;
  required: boolean;
  acceptableLabels: string[];
  instruction: string;
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface AtlasSetupBlocker {
  code: "atlas_target_not_confirmed" | "computer_use_command_not_configured";
  message: string;
}

interface AtlasControllerResult {
  schemaVersion: 1;
  kind: "thehood_chatgpt_atlas_computer_use_result";
  model: string;
  modelVerified: boolean;
  observedModel?: string;
  response: unknown;
}

const defaultOptions: BridgeOptions = {
  model: "chatgpt-pro",
  schemaPath: "",
  target: process.env.THEHOOD_CHATGPT_ATLAS_TARGET ?? "ChatGPT Atlas",
  transport: parseTransport(process.env.THEHOOD_CHATGPT_ATLAS_TRANSPORT ?? "computer-use"),
  timeoutMs: Number(process.env.THEHOOD_CHATGPT_ATLAS_TIMEOUT_MS ?? 600_000),
  commandTimeoutMs: Number(process.env.THEHOOD_CHATGPT_ATLAS_COMMAND_TIMEOUT_MS ?? 15_000),
  allowUnverifiedTarget: process.env.THEHOOD_CHATGPT_ATLAS_TARGET_CONFIRMED === "1",
  ...(process.env.THEHOOD_CHATGPT_ATLAS_COMPUTER_USE_COMMAND
    ? { computerUseCommand: process.env.THEHOOD_CHATGPT_ATLAS_COMPUTER_USE_COMMAND }
    : {}),
  ...(process.env.THEHOOD_CHATGPT_ATLAS_FAKE_RESPONSE
    ? { fakeResponse: process.env.THEHOOD_CHATGPT_ATLAS_FAKE_RESPONSE }
    : {}),
  ...(process.env.THEHOOD_CHATGPT_ATLAS_FAKE_RESPONSE_FILE
    ? { fakeResponseFile: process.env.THEHOOD_CHATGPT_ATLAS_FAKE_RESPONSE_FILE }
    : {})
};

function parseTransport(value: string): AtlasTransport {
  if (value === "computer-use" || value === "fake") {
    return value;
  }

  throw new Error(`Unsupported ChatGPT Atlas transport: ${value}`);
}

const readStdin = async (): Promise<string> =>
  new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });

const parseArgs = (argv: string[]): BridgeOptions => {
  const options = { ...defaultOptions };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--allow-unverified-target") {
      options.allowUnverifiedTarget = true;
      continue;
    }

    if (!arg?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg ?? ""}`);
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }

    switch (arg) {
      case "--model":
        options.model = next;
        break;
      case "--schema":
        options.schemaPath = next;
        break;
      case "--target":
        options.target = next;
        break;
      case "--transport":
        options.transport = parseTransport(next);
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(next);
        break;
      case "--command-timeout-ms":
        options.commandTimeoutMs = Number(next);
        break;
      case "--computer-use-command":
        options.computerUseCommand = next;
        break;
      case "--fake-response":
        options.fakeResponse = next;
        break;
      case "--fake-response-file":
        options.fakeResponseFile = next;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }

    index += 1;
  }

  if (!options.schemaPath) {
    throw new Error("--schema is required.");
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number.");
  }

  if (!Number.isFinite(options.commandTimeoutMs) || options.commandTimeoutMs <= 0) {
    throw new Error("--command-timeout-ms must be a positive number.");
  }

  return options;
};

const readRequiredDataKey = async (schemaPath: string): Promise<string> => {
  const raw = await fs.readFile(schemaPath, "utf8");
  const schema = JSON.parse(raw) as {
    properties?: {
      data?: {
        required?: string[];
      };
    };
  };
  const key = schema.properties?.data?.required?.[0];

  if (!key) {
    throw new Error(`Could not infer AgentResponse data key from schema: ${schemaPath}`);
  }

  return key;
};

const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const modelLabels = (model: string): string[] => {
  if (model === "chatgpt-pro" || model === "pro") {
    return [
      "Pro",
      "ChatGPT Pro",
      "Extended Pro",
      "GPT-5.5 Pro",
      "GPT-5.5 Extended Pro"
    ];
  }

  if (model === "configured") {
    return ["configured"];
  }

  return [model, model.replace(/-/g, " ")];
};

const atlasModelSelection = (model: string): AtlasModelSelection => {
  const required = model !== "configured";

  return {
    requestedModel: model,
    required,
    acceptableLabels: modelLabels(model),
    instruction: required
      ? [
          `Before posting the prompt, verify the visible Atlas model selector matches ${model}.`,
          "If it does not, open the selector, choose an acceptable Pro label, and verify the selector changed before typing.",
          "If the requested model cannot be selected or verified, return a controller result with modelVerified:false and do not send the prompt."
        ].join(" ")
      : [
          "Use the controller's configured Atlas model policy.",
          "Verify the visible selector before typing when the controller has a configured target model."
        ].join(" ")
  };
};

const extractExpectedDirectiveAck = (prompt: string): ExpectedDirectiveAck | undefined => {
  const marker = "Runtime directive:";
  const markerIndex = prompt.lastIndexOf(marker);
  if (markerIndex === -1) {
    return undefined;
  }

  const rawDirective = prompt.slice(markerIndex + marker.length).trim();
  if (!rawDirective) {
    return undefined;
  }

  try {
    const directive = JSON.parse(rawDirective) as { directiveAck?: unknown; variables?: { directiveAck?: unknown } };
    const ack = isJsonObject(directive.directiveAck)
      ? directive.directiveAck
      : isJsonObject(directive.variables?.directiveAck)
        ? directive.variables.directiveAck
        : undefined;
    if (
      typeof ack?.runId === "string" &&
      typeof ack.nonce === "string" &&
      typeof ack.responseField === "string"
    ) {
      return {
        runId: ack.runId,
        nonce: ack.nonce,
        responseField: ack.responseField
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const withDirectiveAck = (payload: JsonObject, expectedAck: ExpectedDirectiveAck | undefined): JsonObject => {
  if (!expectedAck) {
    return payload;
  }

  return {
    ...payload,
    [expectedAck.responseField]: {
      runId: expectedAck.runId,
      nonce: expectedAck.nonce,
      responseField: expectedAck.responseField
    }
  };
};

const payloadForKey = (
  requiredDataKey: string,
  summary: string,
  expectedAck: ExpectedDirectiveAck | undefined
): JsonObject => {
  switch (requiredDataKey) {
    case "decision":
      return withDirectiveAck({
        action: "request_approval",
        reason: summary
      }, expectedAck);
    case "implementationResult":
      return withDirectiveAck({
        status: "blocked",
        changedFiles: [],
        commandsRun: [],
        unresolvedRisks: [summary]
      }, expectedAck);
    case "qaResult":
      return withDirectiveAck({
        verdict: "blocked",
        summary,
        suggestedCommands: [],
        risks: [summary]
      }, expectedAck);
    case "verificationResult":
      return withDirectiveAck({
        verdict: "ask_user",
        summary,
        failedCriteria: ["chatgpt_atlas_bridge"],
        risks: [summary],
        nextAction: "user"
      }, expectedAck);
    case "critiqueResult":
      return withDirectiveAck({
        verdict: "unclear",
        blockingConcerns: [summary],
        nonBlockingConcerns: []
      }, expectedAck);
    default:
      return withDirectiveAck({
        summary
      }, expectedAck);
  }
};

const fallback = (
  requiredDataKey: string,
  summary: string,
  status: AgentResponse["status"] = "blocked",
  expectedAck?: ExpectedDirectiveAck
): AgentResponse => ({
  status,
  summary,
  data: {
    [requiredDataKey]: payloadForKey(requiredDataKey, summary, expectedAck)
  }
});

const tryParseJson = (text: string): unknown | undefined => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const fencedCodeBlocks = (text: string): string[] => {
  const blocks: string[] = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const block = match[1]?.trim();
    if (block) {
      blocks.push(block);
    }
  }

  return blocks;
};

const balancedJsonObjects = (text: string): string[] => {
  const objects: string[] = [];

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          continue;
        }

        if (char === "\"") {
          inString = false;
        }

        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{") {
        depth += 1;
        continue;
      }

      if (char === "}") {
        depth -= 1;

        if (depth === 0) {
          objects.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }

  return objects;
};

const jsonCandidateStrings = (text: string): string[] => {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  return [
    trimmed,
    ...fencedCodeBlocks(trimmed).reverse(),
    ...balancedJsonObjects(trimmed).reverse(),
    ...lines
  ];
};

const isAgentResponse = (value: unknown): value is AgentResponse => {
  if (!isJsonObject(value)) {
    return false;
  }

  const candidate = value as Partial<AgentResponse>;
  return (
    (candidate.status === "ok" || candidate.status === "blocked" || candidate.status === "failed") &&
    typeof candidate.summary === "string" &&
    isJsonObject(candidate.data)
  );
};

const isAtlasControllerResult = (value: unknown): value is AtlasControllerResult => {
  if (!isJsonObject(value)) {
    return false;
  }

  return (
    value.schemaVersion === 1 &&
    value.kind === "thehood_chatgpt_atlas_computer_use_result" &&
    typeof value.model === "string" &&
    typeof value.modelVerified === "boolean" &&
    value.response !== undefined
  );
};

const hasRequiredDataKey = (response: AgentResponse, requiredDataKey: string | undefined): boolean => {
  if (!requiredDataKey) {
    return true;
  }

  return isJsonObject(response.data[requiredDataKey]);
};

const directiveAckError = (
  response: AgentResponse,
  requiredDataKey: string | undefined,
  expectedAck: ExpectedDirectiveAck | undefined
): string | undefined => {
  if (!expectedAck || !requiredDataKey) {
    return undefined;
  }

  const payload = response.data[requiredDataKey];
  if (!isJsonObject(payload)) {
    return undefined;
  }

  const ack = payload[expectedAck.responseField];
  if (!isJsonObject(ack)) {
    return `AgentResponse data.${requiredDataKey}.${expectedAck.responseField} is missing.`;
  }

  if (ack.runId !== expectedAck.runId || ack.nonce !== expectedAck.nonce) {
    return `AgentResponse acknowledged a stale directive for run ${String(ack.runId)}.`;
  }

  return undefined;
};

const unwrapAgentResponse = (value: unknown, requiredDataKey?: string): unknown => {
  if (isAgentResponse(value)) {
    return value;
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const candidate = value as { result?: unknown; message?: unknown };

  if (typeof candidate.result === "string") {
    return parseAgentResponse(candidate.result, requiredDataKey) ?? value;
  }

  if (candidate.result !== undefined) {
    return candidate.result;
  }

  if (typeof candidate.message === "string") {
    return parseAgentResponse(candidate.message, requiredDataKey) ?? value;
  }

  return value;
};

const parseAgentResponse = (text: string, requiredDataKey?: string): AgentResponse | undefined =>
  parseAgentResponseCandidate(text, requiredDataKey).response;

const parseAgentResponseCandidate = (
  text: string,
  requiredDataKey?: string,
  expectedAck?: ExpectedDirectiveAck
): { response?: AgentResponse; ackError?: string } => {
  for (const candidate of jsonCandidateStrings(text)) {
    const parsed = tryParseJson(candidate);
    const unwrapped = unwrapAgentResponse(parsed, requiredDataKey);

    if (isAgentResponse(unwrapped) && hasRequiredDataKey(unwrapped, requiredDataKey)) {
      const ackError = directiveAckError(unwrapped, requiredDataKey, expectedAck);
      return ackError ? { ackError } : { response: unwrapped };
    }
  }

  return {};
};

const parseVerifiedControllerResponse = (
  result: AtlasControllerResult,
  expectedModel: string,
  requiredDataKey: string | undefined,
  expectedAck: ExpectedDirectiveAck | undefined
): { response?: AgentResponse; error?: string; ackError?: string } => {
  if (result.model !== expectedModel) {
    return {
      error: `Computer Use controller verified model ${result.model}, but TheHood requested ${expectedModel}.`
    };
  }

  if (!result.modelVerified) {
    return {
      error: [
        `Computer Use controller did not verify requested model ${expectedModel}.`,
        result.observedModel ? `Observed model: ${result.observedModel}.` : undefined
      ].filter(Boolean).join(" ")
    };
  }

  const parsedResponse = typeof result.response === "string"
    ? parseAgentResponseCandidate(result.response, requiredDataKey, expectedAck)
    : (() => {
        const unwrapped = unwrapAgentResponse(result.response, requiredDataKey);
        if (isAgentResponse(unwrapped) && hasRequiredDataKey(unwrapped, requiredDataKey)) {
          const ackError = directiveAckError(unwrapped, requiredDataKey, expectedAck);
          return ackError ? { ackError } : { response: unwrapped };
        }

        return {};
      })();

  if (parsedResponse.response || parsedResponse.ackError) {
    return parsedResponse;
  }

  return {
    error: "Computer Use controller result did not include a schema-valid AgentResponse in response."
  };
};

const parseControllerOutput = (
  requiredDataKey: string,
  expectedAck: ExpectedDirectiveAck | undefined,
  expectedModel: string,
  output: string
): { response?: AgentResponse; error?: string; ackError?: string } => {
  for (const candidate of jsonCandidateStrings(output)) {
    const parsed = tryParseJson(candidate);

    if (isAtlasControllerResult(parsed)) {
      return parseVerifiedControllerResponse(parsed, expectedModel, requiredDataKey, expectedAck);
    }
  }

  const legacyAgentResponse = parseAgentResponseCandidate(output, requiredDataKey, expectedAck);
  if (legacyAgentResponse.response) {
    return {
      error: [
        `ChatGPT Atlas Computer Use controller returned a raw AgentResponse without model verification for ${expectedModel}.`,
        "Return kind:thehood_chatgpt_atlas_computer_use_result with modelVerified:true after selecting/verifying the Atlas model before posting the prompt."
      ].join(" ")
    };
  }

  if (legacyAgentResponse.ackError) {
    return { ackError: legacyAgentResponse.ackError };
  }

  return {};
};

const runProcess = async (
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number
): Promise<ProcessResult> => {
  const child = spawn(command, args, {
    shell: false,
    env: process.env,
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
  child.stdin.end(stdin);

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });

    return {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      timedOut
    };
  } finally {
    clearTimeout(timer);
  }
};

const fakeResponseText = async (options: BridgeOptions): Promise<string | undefined> => {
  if (options.fakeResponseFile) {
    return fs.readFile(options.fakeResponseFile, "utf8");
  }

  return options.fakeResponse;
};

const parseTransportOutput = (
  requiredDataKey: string,
  expectedAck: ExpectedDirectiveAck | undefined,
  output: string,
  sourceLabel: string
): AgentResponse => {
  const { response, ackError } = parseAgentResponseCandidate(output, requiredDataKey, expectedAck);

  if (response) {
    return response;
  }

  if (ackError) {
    return fallback(
      requiredDataKey,
      `ChatGPT Atlas bridge rejected ${sourceLabel} output: ${ackError}`,
      "failed",
      expectedAck
    );
  }

  return fallback(
    requiredDataKey,
    `ChatGPT Atlas bridge could not find a schema-valid AgentResponse in ${sourceLabel} output.`,
    "blocked",
    expectedAck
  );
};

const runFakeTransport = async (
  options: BridgeOptions,
  requiredDataKey: string,
  expectedAck: ExpectedDirectiveAck | undefined
): Promise<AgentResponse> => {
  const output = await fakeResponseText(options);

  if (!output) {
    return fallback(
      requiredDataKey,
      "ChatGPT Atlas fake transport requires THEHOOD_CHATGPT_ATLAS_FAKE_RESPONSE or THEHOOD_CHATGPT_ATLAS_FAKE_RESPONSE_FILE.",
      "blocked",
      expectedAck
    );
  }

  return parseTransportOutput(requiredDataKey, expectedAck, output, "fake transport");
};

const controllerRequest = (
  options: BridgeOptions,
  prompt: string,
  requiredDataKey: string,
  expectedAck: ExpectedDirectiveAck | undefined
): JsonObject => ({
  schemaVersion: 1,
  kind: "thehood_chatgpt_atlas_computer_use_request",
  target: options.target,
  model: options.model,
  modelSelection: atlasModelSelection(options.model) as unknown as JsonObject,
  transport: "computer-use",
  timeoutMs: options.timeoutMs,
  requiredDataKey,
  prompt,
  ...(expectedAck ? { directiveAck: expectedAck as unknown as JsonObject } : {})
});

const atlasSetupBlockers = (options: BridgeOptions): AtlasSetupBlocker[] => [
  ...(!options.allowUnverifiedTarget
    ? [{
        code: "atlas_target_not_confirmed" as const,
        message: [
          `ChatGPT Atlas bridge requires target confirmation for ${options.target}.`,
          "Select the intended Atlas window, then set THEHOOD_CHATGPT_ATLAS_TARGET_CONFIRMED=1 or pass --allow-unverified-target. The Computer Use controller must verify the requested model before posting."
        ].join(" ")
      }]
    : []),
  ...(!options.computerUseCommand
    ? [{
        code: "computer_use_command_not_configured" as const,
        message: [
          "ChatGPT Atlas bridge is packaged, but no local Computer Use controller is configured.",
          "Set THEHOOD_CHATGPT_ATLAS_COMPUTER_USE_COMMAND to a trusted executable that operates the selected Atlas window, verifies the requested model, and returns the verified controller result envelope."
        ].join(" ")
      }]
    : [])
];

const atlasSetupSummary = (blockers: AtlasSetupBlocker[]): string =>
  [
    `ChatGPT Atlas setup is incomplete (${blockers.map((blocker) => blocker.code).join(", ")}).`,
    ...blockers.map((blocker) => blocker.message)
  ].join(" ");

const runComputerUseTransport = async (
  options: BridgeOptions,
  prompt: string,
  requiredDataKey: string,
  expectedAck: ExpectedDirectiveAck | undefined
): Promise<AgentResponse> => {
  const setupBlockers = atlasSetupBlockers(options);
  if (setupBlockers.length > 0) {
    return fallback(
      requiredDataKey,
      atlasSetupSummary(setupBlockers),
      "blocked",
      expectedAck
    );
  }

  const request = controllerRequest(options, prompt, requiredDataKey, expectedAck);
  const computerUseCommand = options.computerUseCommand;
  if (!computerUseCommand) {
    throw new Error("ChatGPT Atlas setup preflight invariant failed: missing Computer Use controller command.");
  }

  const result = await runProcess(
    computerUseCommand,
    [
      "--target",
      options.target,
      "--model",
      options.model,
      "--schema",
      options.schemaPath,
      "--timeout-ms",
      String(options.timeoutMs)
    ],
    `${JSON.stringify(request)}\n`,
    options.commandTimeoutMs
  );

  if (result.timedOut) {
    return fallback(
      requiredDataKey,
      `ChatGPT Atlas Computer Use controller timed out after ${options.commandTimeoutMs}ms.`,
      "failed",
      expectedAck
    );
  }

  if (result.exitCode !== 0) {
    return fallback(
      requiredDataKey,
      `ChatGPT Atlas Computer Use controller exited with code ${result.exitCode}.`,
      "failed",
      expectedAck
    );
  }

  const parsed = parseControllerOutput(requiredDataKey, expectedAck, options.model, result.stdout);
  if (parsed.response) {
    return parsed.response;
  }

  if (parsed.ackError) {
    return fallback(
      requiredDataKey,
      `ChatGPT Atlas bridge rejected Computer Use controller output: ${parsed.ackError}`,
      "failed",
      expectedAck
    );
  }

  return fallback(
    requiredDataKey,
    parsed.error ?? "ChatGPT Atlas bridge could not find a verified controller result in Computer Use controller output.",
    "blocked",
    expectedAck
  );
};

const run = async (): Promise<AgentResponse> => {
  const options = parseArgs(process.argv.slice(2));
  const requiredDataKey = await readRequiredDataKey(options.schemaPath);
  const prompt = await readStdin();
  const expectedAck = extractExpectedDirectiveAck(prompt);

  if (options.transport === "fake") {
    return runFakeTransport(options, requiredDataKey, expectedAck);
  }

  return runComputerUseTransport(options, prompt, requiredDataKey, expectedAck);
};

run()
  .then((response) => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    let requiredDataKey = "decision";

    try {
      const options = parseArgs(process.argv.slice(2));
      requiredDataKey = await readRequiredDataKey(options.schemaPath);
    } catch {
      // Keep the generic decision fallback.
    }

    process.stdout.write(`${JSON.stringify(fallback(requiredDataKey, message, "failed"))}\n`);
  });
