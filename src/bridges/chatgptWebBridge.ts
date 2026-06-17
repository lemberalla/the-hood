#!/usr/bin/env node
import fs from "node:fs/promises";
import type { AgentResponse } from "../providers/types.js";
import type { JsonObject } from "../runtime/types.js";

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
  timeoutMs: number;
  promptSelector: string;
  sendSelector: string;
  responseSelector: string;
  allowUnverifiedModel: boolean;
}

interface ChromeTarget {
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpClient {
  evaluate<T>(expression: string): Promise<T>;
  close(): void;
}

const defaultOptions: BridgeOptions = {
  model: "chatgpt-pro",
  schemaPath: "",
  cdpUrl: process.env.THEHOOD_CHATGPT_WEB_CDP_URL ?? "http://127.0.0.1:9222",
  timeoutMs: Number(process.env.THEHOOD_CHATGPT_WEB_TIMEOUT_MS ?? 120_000),
  promptSelector:
    process.env.THEHOOD_CHATGPT_WEB_PROMPT_SELECTOR ?? "#prompt-textarea,[contenteditable='true'],textarea",
  sendSelector:
    process.env.THEHOOD_CHATGPT_WEB_SEND_SELECTOR ??
    "button[data-testid='send-button'],button[aria-label*='Send'],button[aria-label*='send']",
  responseSelector:
    process.env.THEHOOD_CHATGPT_WEB_RESPONSE_SELECTOR ?? "[data-message-author-role='assistant']",
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
      case "--timeout-ms":
        options.timeoutMs = Number(next);
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

const payloadForKey = (requiredDataKey: string, summary: string): JsonObject => {
  switch (requiredDataKey) {
    case "decision":
      return {
        action: "request_approval",
        reason: summary
      };
    case "implementationResult":
      return {
        status: "blocked",
        changedFiles: [],
        commandsRun: [],
        unresolvedRisks: [summary]
      };
    case "verificationResult":
      return {
        verdict: "ask_user",
        summary,
        failedCriteria: ["chatgpt_web_bridge"],
        risks: [summary],
        nextAction: "user"
      };
    case "critiqueResult":
      return {
        verdict: "unclear",
        blockingConcerns: [summary],
        nonBlockingConcerns: []
      };
    default:
      return {
        summary
      };
  }
};

const fallback = (requiredDataKey: string, summary: string, status: AgentResponse["status"] = "blocked"): AgentResponse => ({
  status,
  summary,
  data: {
    [requiredDataKey]: payloadForKey(requiredDataKey, summary)
  }
});

const parseJsonCandidate = (text: string): unknown | undefined => {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
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

const connectCdp = async (webSocketUrl: string): Promise<CdpClient> => {
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const socket = new WebSocket(webSocketUrl);

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome DevTools websocket.")));
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

    if (message.error) {
      callbacks.reject(new Error(message.error.message ?? "Chrome DevTools command failed."));
      return;
    }

    callbacks.resolve(message.result);
  });

  socket.addEventListener("close", () => {
    for (const callbacks of pending.values()) {
      callbacks.reject(new Error("Chrome DevTools websocket closed."));
    }
    pending.clear();
  });

  const send = (method: string, params: JsonObject): Promise<unknown> => {
    const id = nextId;
    nextId += 1;

    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve,
        reject
      });

      socket.send(JSON.stringify({
        id,
        method,
        params
      }));
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
    close() {
      socket.close();
    }
  };
};

const assistantSnapshotExpression = (responseSelector: string): string => `
(() => {
  const nodes = Array.from(document.querySelectorAll(${JSON.stringify(responseSelector)}));
  return nodes.map((node) => (node.textContent || '').trim()).filter(Boolean);
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
    editor.value = prompt;
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

  for (let attempt = 0; !button && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    button = findEnabledButton();
  }

  if (button) {
    button.click();
    return { ok: true };
  }

  editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', metaKey: true }));
  editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', metaKey: true }));
  await new Promise((resolve) => setTimeout(resolve, 500));

  return { ok: false, error: 'send button not found or disabled' };
})()
`;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const waitForAgentResponse = async (
  client: CdpClient,
  responseSelector: string,
  previousCount: number,
  timeoutMs: number
): Promise<AgentResponse | undefined> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const responses = await client.evaluate<string[]>(assistantSnapshotExpression(responseSelector));
    const candidates = responses.slice(previousCount).reverse();

    for (const candidate of candidates) {
      const parsed = parseJsonCandidate(candidate);
      if (isAgentResponse(parsed)) {
        return parsed;
      }
    }

    await sleep(1_000);
  }

  return undefined;
};

const run = async (): Promise<AgentResponse> => {
  const options = parseArgs(process.argv.slice(2));
  const requiredDataKey = await readRequiredDataKey(options.schemaPath);
  const prompt = await readStdin();

  if (!options.allowUnverifiedModel) {
    return fallback(
      requiredDataKey,
      `ChatGPT Web bridge requires explicit model confirmation for ${options.model}. Set THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED=1 or pass --allow-unverified-model after selecting the model in ChatGPT.`
    );
  }

  if (typeof WebSocket === "undefined") {
    return fallback(requiredDataKey, "This Node.js runtime does not provide WebSocket support.", "failed");
  }

  const target = await findChatGptTarget(options.cdpUrl);
  const client = await connectCdp(target.webSocketDebuggerUrl ?? "");

  try {
    const before = await client.evaluate<string[]>(assistantSnapshotExpression(options.responseSelector));
    const sent = await client.evaluate<{ ok: boolean; error?: string }>(
      sendPromptExpression(prompt, options.promptSelector, options.sendSelector)
    );

    if (!sent.ok) {
      return fallback(requiredDataKey, `ChatGPT Web bridge could not send prompt: ${sent.error ?? "unknown error"}`);
    }

    return (
      await waitForAgentResponse(client, options.responseSelector, before.length, options.timeoutMs)
    ) ?? fallback(requiredDataKey, "ChatGPT Web bridge timed out waiting for AgentResponse JSON.");
  } finally {
    client.close();
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
