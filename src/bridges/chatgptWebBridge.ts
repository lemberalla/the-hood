#!/usr/bin/env node
import fs from "node:fs/promises";
import type { AgentResponse } from "../providers/types.js";
import { classifyChatGptPageSnapshot, chatGptPageSnapshotExpression } from "../runtime/chatGptPageReadiness.js";
import type { JsonObject } from "../runtime/types.js";
import type { ChatGptPageReadiness, ChatGptPageSnapshot } from "../runtime/chatGptPageReadiness.js";

declare const WebSocket: {
  new (url: string): {
    addEventListener(event: "open", listener: () => void): void;
    addEventListener(event: "message", listener: (event: { data: unknown }) => void): void;
    addEventListener(event: "error", listener: (event: unknown) => void): void;
    addEventListener(event: "close", listener: () => void): void;
    send(data: string): void;
    close(): void;
  };
};

interface BridgeOptions {
  model: string;
  schemaPath: string;
  cdpUrl: string;
  freshUrl: string;
  timeoutMs: number;
  commandTimeoutMs: number;
  promptSelector: string;
  sendSelector: string;
  responseSelector: string;
  newChatSelector: string;
  reuseChat: boolean;
  keepCreatedTarget: boolean;
  allowUnverifiedModel: boolean;
}

interface ChromeTarget {
  id?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpClient {
  evaluate<T>(expression: string): Promise<T>;
  navigate(url: string): Promise<void>;
  close(): void;
}

interface ResponseDiagnostics {
  assistantCount: number;
  candidateCount: number;
  latestLength: number;
  elapsedMs: number;
}

interface ExpectedDirectiveAck {
  runId: string;
  nonce: string;
  responseField: string;
}

const defaultOptions: BridgeOptions = {
  model: "chatgpt-pro",
  schemaPath: "",
  cdpUrl: process.env.THEHOOD_CHATGPT_WEB_CDP_URL ?? "http://127.0.0.1:9222",
  freshUrl: process.env.THEHOOD_CHATGPT_WEB_FRESH_URL ?? "https://chatgpt.com/",
  timeoutMs: Number(process.env.THEHOOD_CHATGPT_WEB_TIMEOUT_MS ?? 300_000),
  commandTimeoutMs: Number(process.env.THEHOOD_CHATGPT_WEB_CDP_COMMAND_TIMEOUT_MS ?? 15_000),
  promptSelector:
    process.env.THEHOOD_CHATGPT_WEB_PROMPT_SELECTOR ?? "#prompt-textarea,[contenteditable='true'],textarea",
  sendSelector:
    process.env.THEHOOD_CHATGPT_WEB_SEND_SELECTOR ??
    "button[data-testid='send-button'],button[aria-label*='Send'],button[aria-label*='send']",
  responseSelector:
    process.env.THEHOOD_CHATGPT_WEB_RESPONSE_SELECTOR ?? "[data-message-author-role='assistant']",
  newChatSelector:
    process.env.THEHOOD_CHATGPT_WEB_NEW_CHAT_SELECTOR ??
    "a[href='/'],a[href='/?model=auto'],button[aria-label*='New chat'],a[aria-label*='New chat'],[data-testid='create-new-chat-button']",
  reuseChat: process.env.THEHOOD_CHATGPT_WEB_REUSE_CHAT === "1",
  keepCreatedTarget: process.env.THEHOOD_CHATGPT_WEB_KEEP_TARGET === "1",
  allowUnverifiedModel:
    process.env.THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED === "1" ||
    process.env.THEHOOD_CHATGPT_WEB_ALLOW_UNVERIFIED_MODEL === "1"
};

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

    if (arg === "--allow-unverified-model") {
      options.allowUnverifiedModel = true;
      continue;
    }

    if (arg === "--reuse-chat") {
      options.reuseChat = true;
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
      case "--cdp-url":
        options.cdpUrl = next;
        break;
      case "--fresh-url":
        options.freshUrl = next;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(next);
        break;
      case "--command-timeout-ms":
        options.commandTimeoutMs = Number(next);
        break;
      case "--prompt-selector":
        options.promptSelector = next;
        break;
      case "--send-selector":
        options.sendSelector = next;
        break;
      case "--response-selector":
        options.responseSelector = next;
        break;
      case "--new-chat-selector":
        options.newChatSelector = next;
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
        failedCriteria: ["chatgpt_web_bridge"],
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

const repairMissingClosingBraces = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const char of trimmed) {
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
      if (depth < 0) {
        return undefined;
      }
    }
  }

  if (inString || depth <= 0 || depth > 3) {
    return undefined;
  }

  return `${trimmed}${"}".repeat(depth)}`;
};

const tryParseJson = (text: string): unknown | undefined => {
  try {
    return JSON.parse(text);
  } catch {
    const repaired = repairMissingClosingBraces(text);
    if (!repaired) {
      return undefined;
    }

    try {
      return JSON.parse(repaired);
    } catch {
      return undefined;
    }
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
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<AgentResponse>;
  return (
    (candidate.status === "ok" || candidate.status === "blocked" || candidate.status === "failed") &&
    typeof candidate.summary === "string" &&
    candidate.data !== null &&
    typeof candidate.data === "object" &&
    !Array.isArray(candidate.data)
  );
};

const hasRequiredDataKey = (response: AgentResponse, requiredDataKey: string | undefined): boolean => {
  if (!requiredDataKey) {
    return true;
  }

  const payload = response.data[requiredDataKey];
  return payload !== null && typeof payload === "object" && !Array.isArray(payload);
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

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
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

const listTargets = async (cdpUrl: string): Promise<ChromeTarget[]> => {
  const response = await fetch(new URL("/json/list", cdpUrl));

  if (!response.ok) {
    throw new Error(`Chrome DevTools returned ${response.status}.`);
  }

  return (await response.json()) as ChromeTarget[];
};

const findChatGptTarget = async (cdpUrl: string): Promise<ChromeTarget> => {
  const targets = await listTargets(cdpUrl);
  const target = targets.find((candidate) => {
    const url = candidate.url ?? "";
    return (
      candidate.webSocketDebuggerUrl &&
      (url.includes("chatgpt.com") || url.includes("chat.openai.com"))
    );
  });

  if (!target?.webSocketDebuggerUrl) {
    throw new Error("No ChatGPT tab with a DevTools websocket was found.");
  }

  return target;
};

const createChatGptTarget = async (cdpUrl: string, freshUrl: string): Promise<ChromeTarget> => {
  const response = await fetch(new URL(`/json/new?${encodeURIComponent(freshUrl)}`, cdpUrl), {
    method: "PUT"
  });

  if (!response.ok) {
    throw new Error(`Chrome DevTools could not create a fresh ChatGPT target: ${response.status}.`);
  }

  const target = await response.json() as ChromeTarget;
  if (!target.webSocketDebuggerUrl) {
    throw new Error("Chrome DevTools created a target without a websocket URL.");
  }

  return target;
};

const closeChromeTarget = async (cdpUrl: string, target: ChromeTarget | undefined): Promise<void> => {
  if (!target?.id) {
    return;
  }

  await fetch(new URL(`/json/close/${encodeURIComponent(target.id)}`, cdpUrl)).catch(() => undefined);
};

const connectCdp = async (webSocketUrl: string, commandTimeoutMs: number): Promise<CdpClient> => {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  const socket = new WebSocket(webSocketUrl);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Could not connect to Chrome DevTools websocket within ${commandTimeoutMs}ms.`));
      socket.close();
    }, commandTimeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not connect to Chrome DevTools websocket."));
    });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: {
        message?: string;
      };
    };

    if (!message.id) {
      return;
    }

    const callbacks = pending.get(message.id);
    if (!callbacks) {
      return;
    }

    pending.delete(message.id);
    clearTimeout(callbacks.timer);

    if (message.error) {
      callbacks.reject(new Error(message.error.message ?? "Chrome DevTools command failed."));
      return;
    }

    callbacks.resolve(message.result);
  });

  socket.addEventListener("close", () => {
    for (const callbacks of pending.values()) {
      clearTimeout(callbacks.timer);
      callbacks.reject(new Error("Chrome DevTools websocket closed."));
    }
    pending.clear();
  });

  const send = (method: string, params: JsonObject): Promise<unknown> => {
    const id = nextId;
    nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Chrome DevTools command ${method} timed out after ${commandTimeoutMs}ms.`));
        socket.close();
      }, commandTimeoutMs);
      pending.set(id, {
        resolve,
        reject,
        timer
      });

      try {
        socket.send(JSON.stringify({
          id,
          method,
          params
        }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  return {
    async evaluate<T>(expression: string): Promise<T> {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true
      }) as {
        result?: {
          value?: T;
        };
        exceptionDetails?: {
          text?: string;
        };
      };

      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed.");
      }

      return result.result?.value as T;
    },
    async navigate(url: string): Promise<void> {
      await send("Page.navigate", {
        url
      });
    },
    close() {
      socket.close();
    }
  };
};

const promptEditorReadyExpression = (promptSelector: string): string => `
(() => {
  const promptSelectors = ${JSON.stringify(promptSelector)}.split(',').map((selector) => selector.trim()).filter(Boolean);
  return promptSelectors.some((selector) => Boolean(document.querySelector(selector)));
})()
`;

const assistantSnapshotExpression = (responseSelector: string): string => `
(() => {
  const selected = Array.from(document.querySelectorAll(${JSON.stringify(responseSelector)}));
  const fallbackNodes = selected.length > 0
    ? []
    : Array.from(document.querySelectorAll('[data-message-author-role="assistant"], [data-testid^="conversation-turn-"]'))
      .filter((node) => {
        const role = node.getAttribute('data-message-author-role')
          || node.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role');
        return role === 'assistant';
      });
  const nodes = selected.length > 0 ? selected : fallbackNodes;
  return nodes.map((node) => (node.textContent || '').trim()).filter(Boolean);
})()
`;

const chatGptErrorExpression = (): string => `
(() => {
  const text = document.body?.innerText || '';
  const messages = [
    'Message delivery timed out',
    'Something went wrong',
    'There was an error generating a response',
    'Unable to load conversation'
  ];
  return messages.find((message) => text.includes(message)) || null;
})()
`;

const sendPromptExpression = (prompt: string, promptSelector: string, sendSelector: string): string => `
(async () => {
  const promptSelectors = ${JSON.stringify(promptSelector)}.split(',').map((selector) => selector.trim()).filter(Boolean);
  const sendSelectors = ${JSON.stringify(sendSelector)}.split(',').map((selector) => selector.trim()).filter(Boolean);
  const prompt = ${JSON.stringify(prompt)};
  const editor = promptSelectors.map((selector) => document.querySelector(selector)).find(Boolean);

  if (!editor) {
    return { ok: false, error: 'prompt editor not found' };
  }

  editor.focus();

  if ('value' in editor) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')?.set;
    if (setter) {
      setter.call(editor, prompt);
    } else {
      editor.value = prompt;
    }
  } else {
    editor.textContent = prompt;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: prompt }));
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));

  const findEnabledButton = () => sendSelectors
    .map((selector) => document.querySelector(selector))
    .find((candidate) => candidate && !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true');
  let button = findEnabledButton();

  for (let attempt = 0; !button && attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    button = findEnabledButton();
  }

  if (button) {
    button.click();
    return { ok: true, method: 'button' };
  }

  editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
  editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', metaKey: true }));
  editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', metaKey: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));

  return { ok: true, method: 'keyboard' };
})()
`;

const clickNewChatExpression = (newChatSelector: string): string => `
(() => {
  const selectors = ${JSON.stringify(newChatSelector)}.split(',').map((selector) => selector.trim()).filter(Boolean);
  const selected = selectors
    .map((selector) => document.querySelector(selector))
    .find(Boolean);

  const textMatch = selected || Array.from(document.querySelectorAll('a,button'))
    .find((node) => /new chat/i.test(node.getAttribute('aria-label') || node.textContent || ''));

  if (!textMatch) {
    return false;
  }

  textMatch.click();
  return true;
})()
`;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const loginRequiredMessage =
  "ChatGPT Web session requires login in the TheHood-managed browser profile. Run thehood browser start, sign in to ChatGPT in that window, then retry.";

const waitForPromptEditor = async (
  client: CdpClient,
  promptSelector: string,
  timeoutMs: number
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (await client.evaluate<boolean>(promptEditorReadyExpression(promptSelector))) {
        return true;
      }
    } catch {
      // Navigation can briefly invalidate the execution context.
    }

    await sleep(500);
  }

  return false;
};

const waitForChatGptPageReadiness = async (
  client: CdpClient,
  promptSelector: string,
  timeoutMs: number
): Promise<ChatGptPageReadiness | undefined> => {
  const deadline = Date.now() + timeoutMs;
  let latest: ChatGptPageReadiness | undefined;

  while (Date.now() < deadline) {
    try {
      const snapshot = await client.evaluate<ChatGptPageSnapshot>(chatGptPageSnapshotExpression(promptSelector));
      latest = classifyChatGptPageSnapshot(snapshot);
      if (latest.authRequired || latest.composerReady) {
        return latest;
      }
    } catch {
      // Navigation can briefly invalidate the execution context.
    }

    await sleep(500);
  }

  return latest;
};

const assistantCount = async (client: CdpClient, responseSelector: string): Promise<number> =>
  (await client.evaluate<string[]>(assistantSnapshotExpression(responseSelector))).length;

const waitForEmptyAssistantHistory = async (
  client: CdpClient,
  responseSelector: string,
  timeoutMs: number
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  let emptySince: number | undefined;

  while (Date.now() < deadline) {
    try {
      if (await assistantCount(client, responseSelector) === 0) {
        emptySince ??= Date.now();
        if (Date.now() - emptySince >= 1_000) {
          return true;
        }
      } else {
        emptySince = undefined;
      }
    } catch {
      // Navigation can briefly invalidate the execution context.
      emptySince = undefined;
    }

    await sleep(500);
  }

  return false;
};

const ensureFreshComposer = async (
  client: CdpClient,
  promptSelector: string,
  responseSelector: string,
  newChatSelector: string,
  timeoutMs: number
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  if (!await waitForPromptEditor(client, promptSelector, Math.min(timeoutMs, 30_000))) {
    return { ok: false, reason: "ChatGPT Web bridge could not open a fresh ChatGPT composer." };
  }

  if (await waitForEmptyAssistantHistory(client, responseSelector, 2_000)) {
    return { ok: true };
  }

  const clicked = await client.evaluate<boolean>(clickNewChatExpression(newChatSelector)).catch(() => false);
  if (!clicked) {
    return {
      ok: false,
      reason: "ChatGPT Web bridge found existing assistant messages and could not locate a New Chat control."
    };
  }

  if (!await waitForPromptEditor(client, promptSelector, Math.min(timeoutMs, 30_000))) {
    return { ok: false, reason: "ChatGPT Web bridge clicked New Chat but the composer did not become ready." };
  }

  if (!await waitForEmptyAssistantHistory(client, responseSelector, 10_000)) {
    return {
      ok: false,
      reason: "ChatGPT Web bridge could not verify an empty composer after opening New Chat."
    };
  }

  return { ok: true };
};

const waitForAgentResponse = async (
  client: CdpClient,
  responseSelector: string,
  previousResponses: string[],
  requiredDataKey: string,
  expectedAck: ExpectedDirectiveAck | undefined,
  timeoutMs: number
): Promise<{ response?: AgentResponse; browserError?: string; bridgeError?: string; diagnostics: ResponseDiagnostics }> => {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  const previousText = new Set(previousResponses);
  let diagnostics: ResponseDiagnostics = {
    assistantCount: previousResponses.length,
    candidateCount: 0,
    latestLength: previousResponses.at(-1)?.length ?? 0,
    elapsedMs: 0
  };

  while (Date.now() < deadline) {
    let responses: string[];
    try {
      responses = await client.evaluate<string[]>(assistantSnapshotExpression(responseSelector));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        bridgeError: `Chrome DevTools evaluation failed: ${message}`,
        diagnostics
      };
    }
    const newByPosition = responses.slice(previousResponses.length);
    const changedOrNew = responses.filter((response, index) => index >= previousResponses.length || !previousText.has(response));
    const candidates = Array.from(new Set([...newByPosition, ...changedOrNew])).reverse();

    diagnostics = {
      assistantCount: responses.length,
      candidateCount: candidates.length,
      latestLength: responses.at(-1)?.length ?? 0,
      elapsedMs: Date.now() - startedAt
    };

    for (const candidate of candidates) {
      const { response, ackError } = parseAgentResponseCandidate(candidate, requiredDataKey, expectedAck);
      if (response) {
        return {
          response,
          diagnostics
        };
      }
      if (ackError) {
        return {
          bridgeError: `ChatGPT returned stale or unacknowledged AgentResponse JSON: ${ackError}`,
          diagnostics
        };
      }
    }

    let browserError: string | null;
    try {
      browserError = await client.evaluate<string | null>(chatGptErrorExpression());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        bridgeError: `Chrome DevTools evaluation failed: ${message}`,
        diagnostics
      };
    }
    if (browserError) {
      return {
        browserError,
        diagnostics
      };
    }

    await sleep(1_000);
  }

  return {
    diagnostics: {
      ...diagnostics,
      elapsedMs: Date.now() - startedAt
    }
  };
};

const run = async (): Promise<AgentResponse> => {
  const options = parseArgs(process.argv.slice(2));
  const requiredDataKey = await readRequiredDataKey(options.schemaPath);
  const prompt = await readStdin();
  const expectedAck = extractExpectedDirectiveAck(prompt);

  if (!options.allowUnverifiedModel) {
    return fallback(
      requiredDataKey,
      `ChatGPT Web bridge requires explicit model confirmation for ${options.model}. Set THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED=1 or pass --allow-unverified-model after selecting the model in ChatGPT.`,
      "blocked",
      expectedAck
    );
  }

  if (typeof WebSocket === "undefined") {
    return fallback(requiredDataKey, "This Node.js runtime does not provide WebSocket support.", "failed", expectedAck);
  }

  let target: ChromeTarget;
  let client: CdpClient;
  try {
    target = options.reuseChat
      ? await findChatGptTarget(options.cdpUrl)
      : await createChatGptTarget(options.cdpUrl, options.freshUrl);
    client = await connectCdp(target.webSocketDebuggerUrl ?? "", options.commandTimeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fallback(requiredDataKey, `ChatGPT Web bridge failed fast: ${message}`, "failed", expectedAck);
  }

  try {
    if (!options.reuseChat) {
      await client.navigate(options.freshUrl);
    }

    const readiness = await waitForChatGptPageReadiness(
      client,
      options.promptSelector,
      Math.min(options.timeoutMs, 10_000)
    );
    if (readiness?.authRequired) {
      return fallback(requiredDataKey, loginRequiredMessage, "blocked", expectedAck);
    }

    if (!options.reuseChat) {
      const freshness = await ensureFreshComposer(
        client,
        options.promptSelector,
        options.responseSelector,
        options.newChatSelector,
        options.timeoutMs
      );
      if (!freshness.ok) {
        const latestReadiness = await waitForChatGptPageReadiness(client, options.promptSelector, 1_000);
        if (latestReadiness?.authRequired) {
          return fallback(requiredDataKey, loginRequiredMessage, "blocked", expectedAck);
        }

        return fallback(requiredDataKey, freshness.reason, "blocked", expectedAck);
      }
    }

    const before = await client.evaluate<string[]>(assistantSnapshotExpression(options.responseSelector));
    const sent = await client.evaluate<{ ok: boolean; error?: string; method?: string }>(
      sendPromptExpression(prompt, options.promptSelector, options.sendSelector)
    );

    if (!sent.ok) {
      return fallback(
        requiredDataKey,
        `ChatGPT Web bridge could not send prompt: ${sent.error ?? "unknown error"}`,
        "blocked",
        expectedAck
      );
    }

    const result = await waitForAgentResponse(
      client,
      options.responseSelector,
      before,
      requiredDataKey,
      expectedAck,
      options.timeoutMs
    );

    if (result.response) {
      return result.response;
    }

    if (result.browserError) {
      return fallback(requiredDataKey, `ChatGPT reported: ${result.browserError}.`, "blocked", expectedAck);
    }

    if (result.bridgeError) {
      return fallback(requiredDataKey, `ChatGPT Web bridge failed fast: ${result.bridgeError}.`, "failed", expectedAck);
    }

    return fallback(
      requiredDataKey,
      [
        "ChatGPT Web bridge timed out waiting for AgentResponse JSON.",
        `Observed ${result.diagnostics.assistantCount} assistant message(s),`,
        `${result.diagnostics.candidateCount} changed/new candidate(s),`,
        `latest visible response length ${result.diagnostics.latestLength}.`
      ].join(" "),
      "blocked",
      expectedAck
    );
  } finally {
    client.close();
    if (!options.reuseChat && !options.keepCreatedTarget) {
      await closeChromeTarget(options.cdpUrl, target);
    }
  }
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
