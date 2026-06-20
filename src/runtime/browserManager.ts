import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyChatGptPageSnapshot, chatGptPageSnapshotExpression, type ChatGptPageSnapshot } from "./chatGptPageReadiness.js";
import { InputError } from "./errors.js";

declare const WebSocket: {
  new (url: string): {
    addEventListener(event: "open", listener: () => void): void;
    addEventListener(event: "message", listener: (event: { data: unknown }) => void): void;
    addEventListener(event: "error", listener: () => void): void;
    addEventListener(event: "close", listener: () => void): void;
    send(data: string): void;
    close(): void;
  };
};

export interface BrowserManagerOptions {
  port?: number;
  cdpUrl?: string;
  profile?: string;
  profilePath?: string;
  url?: string;
  chromePath?: string;
}

export interface BrowserStatus {
  provider: "chatgpt-web";
  cdpUrl: string;
  profilePath: string;
  chromePath?: string;
  pid?: number;
  cdpReachable: boolean;
  chatGptTabFound: boolean;
  chatGptPageInspected: boolean;
  chatGptAuthenticated: boolean;
  chatGptComposerReady: boolean;
  readyForBridge: boolean;
  targetCount: number;
  issues: string[];
}

export interface BrowserStartResult {
  launched: boolean;
  status: BrowserStatus;
}

export interface BrowserStopResult {
  stopped: boolean;
  status: BrowserStatus;
  reason?: string;
}

interface BrowserState {
  pid: number;
  chromePath: string;
  profilePath: string;
  cdpUrl: string;
  startedAt: string;
}

interface ChromeTarget {
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

const defaultPort = 9222;
const defaultProfile = "chatgpt-web";
const defaultUrl = "https://chatgpt.com/";
const defaultPromptSelector = "#prompt-textarea,[contenteditable='true'],textarea";
const stateFileName = ".thehood-browser.json";

const sanitizeProfileName = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "") || defaultProfile;

const appSupportDir = (): string =>
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "TheHood")
    : path.join(os.homedir(), ".thehood");

export const defaultBrowserProfilePath = (profile = defaultProfile): string =>
  path.join(appSupportDir(), "ChromeProfiles", sanitizeProfileName(profile));

const browserProfilePath = (options: BrowserManagerOptions): string =>
  path.resolve(options.profilePath ?? defaultBrowserProfilePath(options.profile));

const browserCdpUrl = (options: BrowserManagerOptions): string =>
  options.cdpUrl ?? `http://127.0.0.1:${options.port ?? defaultPort}`;

const stateFilePath = (profilePath: string): string => path.join(profilePath, stateFileName);

const fileExecutable = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const commandOnPath = async (command: string): Promise<string | undefined> => {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

  for (const entry of pathEntries) {
    const candidate = path.join(entry, command);
    if (await fileExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
};

const chromeCandidates = (): string[] => {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
    ];
  }

  if (process.platform === "win32") {
    return [
      path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe")
    ];
  }

  return [];
};

export const resolveChromePath = async (requestedPath?: string): Promise<string> => {
  const explicit = requestedPath ?? process.env.THEHOOD_CHROME_PATH;
  if (explicit) {
    if (await fileExecutable(explicit)) {
      return explicit;
    }

    throw new InputError(`Chrome executable is not available or executable: ${explicit}`);
  }

  for (const candidate of chromeCandidates()) {
    if (await fileExecutable(candidate)) {
      return candidate;
    }
  }

  for (const command of ["google-chrome", "chrome", "chromium", "chromium-browser"]) {
    const candidate = await commandOnPath(command);
    if (candidate) {
      return candidate;
    }
  }

  throw new InputError("Could not find Google Chrome. Set THEHOOD_CHROME_PATH or pass --chrome-path.");
};

const readBrowserState = async (profilePath: string): Promise<BrowserState | undefined> => {
  try {
    return JSON.parse(await fs.readFile(stateFilePath(profilePath), "utf8")) as BrowserState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
};

const writeBrowserState = async (state: BrowserState): Promise<void> => {
  await fs.mkdir(state.profilePath, { recursive: true });
  await fs.writeFile(stateFilePath(state.profilePath), `${JSON.stringify(state, null, 2)}\n`, "utf8");
};

const chatGptTargetFound = (targets: ChromeTarget[]): boolean =>
  targets.some((target) => {
    const url = target.url ?? "";
    return Boolean(target.webSocketDebuggerUrl) && (url.includes("chatgpt.com") || url.includes("chat.openai.com"));
  });

const chatGptTarget = (targets: ChromeTarget[]): ChromeTarget | undefined =>
  targets.find((target) => {
    const url = target.url ?? "";
    return Boolean(target.webSocketDebuggerUrl) && (url.includes("chatgpt.com") || url.includes("chat.openai.com"));
  });

const evaluateChromeTarget = async <T>(
  webSocketUrl: string,
  expression: string,
  timeoutMs: number
): Promise<T> => {
  if (typeof WebSocket === "undefined") {
    throw new Error("websocket_unavailable");
  }

  const socket = new WebSocket(webSocketUrl);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 1;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`connect_timeout_${timeoutMs}`));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("connect_failed"));
    });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
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

  const send = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = nextId;
    nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        socket.close();
        reject(new Error(`command_timeout_${timeoutMs}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });

      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  try {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }) as {
      result?: { value?: T };
      exceptionDetails?: { text?: string };
    };

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed.");
    }

    return result.result?.value as T;
  } finally {
    socket.close();
  }
};

const inspectChatGptPage = async (target: ChromeTarget): Promise<{
  pageInspected: boolean;
  authenticated: boolean;
  composerReady: boolean;
  issues: string[];
}> => {
  const targetReadiness = classifyChatGptPageSnapshot({
    ...(target.url ? { url: target.url } : {}),
    ...(target.title ? { title: target.title } : {})
  });

  if (targetReadiness.authRequired || !target.webSocketDebuggerUrl) {
    return {
      pageInspected: false,
      authenticated: false,
      composerReady: false,
      issues: targetReadiness.authRequired ? targetReadiness.issues : ["chatgpt_page_uninspectable"]
    };
  }

  try {
    const snapshot = await evaluateChromeTarget<ChatGptPageSnapshot>(
      target.webSocketDebuggerUrl,
      chatGptPageSnapshotExpression(defaultPromptSelector),
      1_500
    );
    const readiness = classifyChatGptPageSnapshot(snapshot);

    return {
      pageInspected: true,
      authenticated: readiness.authenticated,
      composerReady: readiness.composerReady,
      issues: readiness.issues
    };
  } catch {
    return {
      pageInspected: false,
      authenticated: false,
      composerReady: false,
      issues: ["chatgpt_page_uninspectable"]
    };
  }
};

export const inspectBrowser = async (options: BrowserManagerOptions = {}): Promise<BrowserStatus> => {
  const cdpUrl = browserCdpUrl(options);
  const profilePath = browserProfilePath(options);
  const state = await readBrowserState(profilePath);
  const issues: string[] = [];
  let cdpReachable = false;
  let chatGptTabFound = false;
  let chatGptPageInspected = false;
  let chatGptAuthenticated = false;
  let chatGptComposerReady = false;
  let targetCount = 0;

  try {
    const response = await fetch(new URL("/json/list", cdpUrl), {
      signal: AbortSignal.timeout(1_000)
    });

    if (!response.ok) {
      issues.push(`cdp_http_${response.status}`);
    } else {
      const targets = await response.json() as ChromeTarget[];
      cdpReachable = true;
      targetCount = targets.length;
      chatGptTabFound = chatGptTargetFound(targets);
      const target = chatGptTarget(targets);
      if (!target) {
        issues.push("chatgpt_tab_not_found");
      } else {
        const page = await inspectChatGptPage(target);
        chatGptPageInspected = page.pageInspected;
        chatGptAuthenticated = page.authenticated;
        chatGptComposerReady = page.composerReady;
        issues.push(...page.issues);
      }
    }
  } catch {
    issues.push("cdp_unreachable");
  }

  return {
    provider: "chatgpt-web",
    cdpUrl,
    profilePath,
    ...(state?.chromePath ? { chromePath: state.chromePath } : {}),
    ...(state?.pid ? { pid: state.pid } : {}),
    cdpReachable,
    chatGptTabFound,
    chatGptPageInspected,
    chatGptAuthenticated,
    chatGptComposerReady,
    readyForBridge: cdpReachable && chatGptTabFound && chatGptAuthenticated && chatGptComposerReady,
    targetCount,
    issues: Array.from(new Set(issues))
  };
};

const waitForBrowser = async (options: BrowserManagerOptions): Promise<BrowserStatus> => {
  let latest = await inspectBrowser(options);

  for (let attempt = 0; attempt < 20 && !latest.readyForBridge && !latest.issues.includes("chatgpt_auth_required"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await inspectBrowser(options);
  }

  return latest;
};

const waitForBrowserStop = async (options: BrowserManagerOptions): Promise<BrowserStatus> => {
  let latest = await inspectBrowser(options);

  for (let attempt = 0; attempt < 20 && latest.cdpReachable; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await inspectBrowser(options);
  }

  return latest;
};

export const startBrowser = async (options: BrowserManagerOptions = {}): Promise<BrowserStartResult> => {
  const profilePath = browserProfilePath(options);
  const cdpUrl = browserCdpUrl(options);
  const existing = await inspectBrowser(options);

  if (existing.readyForBridge) {
    return {
      launched: false,
      status: existing
    };
  }

  const chromePath = await resolveChromePath(options.chromePath);
  await fs.mkdir(profilePath, { recursive: true });
  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${options.port ?? defaultPort}`,
      `--user-data-dir=${profilePath}`,
      "--no-first-run",
      "--no-default-browser-check",
      options.url ?? defaultUrl
    ],
    {
      detached: true,
      stdio: "ignore"
    }
  );

  child.unref();

  if (!child.pid) {
    throw new InputError("Chrome launch did not return a process id.");
  }

  await writeBrowserState({
    pid: child.pid,
    chromePath,
    profilePath,
    cdpUrl,
    startedAt: new Date().toISOString()
  });

  return {
    launched: true,
    status: await waitForBrowser(options)
  };
};

const processCommand = async (pid: number): Promise<string | undefined> =>
  new Promise((resolve) => {
    const child = execFile("ps", ["-p", String(pid), "-o", "command="], (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }

      resolve(stdout.trim());
    });
    child.stdin?.end();
  });

export const stopBrowser = async (options: BrowserManagerOptions = {}): Promise<BrowserStopResult> => {
  const profilePath = browserProfilePath(options);
  const state = await readBrowserState(profilePath);

  if (!state) {
    return {
      stopped: false,
      status: await inspectBrowser(options),
      reason: "browser_state_not_found"
    };
  }

  const command = await processCommand(state.pid);
  if (!command || !command.includes(state.profilePath)) {
    return {
      stopped: false,
      status: await inspectBrowser(options),
      reason: "browser_process_not_owned_by_thehood"
    };
  }

  process.kill(state.pid, "SIGTERM");
  await fs.rm(stateFilePath(profilePath), { force: true });

  return {
    stopped: true,
    status: await waitForBrowserStop(options)
  };
};
