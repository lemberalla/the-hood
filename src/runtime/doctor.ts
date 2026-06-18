import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { listProviders } from "./providers.js";
import type { ProviderDescriptor } from "./providers.js";
import type { RoleAssignment, RuntimeRole, TheHoodConfig } from "./types.js";

export interface ProviderHealth {
  id: string;
  enabled: boolean;
  implemented: boolean;
  models: string[];
  command?: string;
  commandFound?: boolean;
  issues: string[];
}

export interface RoleHealth {
  role: RuntimeRole;
  assignment: RoleAssignment;
  providerEnabled: boolean;
  providerImplemented: boolean;
  modelConfigured: boolean;
  commandFound?: boolean;
  issues: string[];
}

export interface RuntimeHealthReport {
  providers: ProviderHealth[];
  roles: RoleHealth[];
}

const implementedProviderIds = new Set(["stub", "chatgpt-web", "codex-cli", "claude-code"]);

interface ChromeTarget {
  url?: string;
  webSocketDebuggerUrl?: string;
}

const commandForProvider = (providerId: string): string | undefined => {
  if (providerId === "chatgpt-web") {
    return process.env.THEHOOD_CHATGPT_WEB_COMMAND;
  }

  if (providerId === "codex-cli") {
    return process.env.THEHOOD_CODEX_COMMAND ?? "codex";
  }

  if (providerId === "claude-code") {
    return process.env.THEHOOD_CLAUDE_COMMAND ?? "claude";
  }

  return undefined;
};

const executableNames = (command: string): string[] => {
  if (process.platform !== "win32") {
    return [command];
  }

  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";");
  return extensions.some((extension) => command.toUpperCase().endsWith(extension.toUpperCase()))
    ? [command]
    : extensions.map((extension) => `${command}${extension.toLowerCase()}`);
};

const canExecute = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const commandExists = async (command: string): Promise<boolean> => {
  if (command.includes("/") || command.includes("\\")) {
    return canExecute(command);
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = executableNames(command);

  for (const entry of pathEntries) {
    for (const name of names) {
      if (await canExecute(path.join(entry, name))) {
        return true;
      }
    }
  }

  return false;
};

const modelConfigured = (provider: ProviderDescriptor | undefined, assignment: RoleAssignment): boolean => {
  if (!provider) {
    return false;
  }

  return provider.models.includes(assignment.model) || provider.models.includes("configured");
};

const bridgeIssues = (providerId: string, command?: string): string[] =>
  providerId === "chatgpt-web" && !command ? ["bridge_command_not_configured"] : [];

const chatGptModelConfirmed = (): boolean =>
  process.env.THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED === "1" ||
  process.env.THEHOOD_CHATGPT_WEB_ALLOW_UNVERIFIED_MODEL === "1";

const chatGptCdpUrl = (): string => process.env.THEHOOD_CHATGPT_WEB_CDP_URL ?? "http://127.0.0.1:9222";

const chatGptCdpIssues = async (): Promise<string[]> => {
  try {
    const response = await fetch(new URL("/json/list", chatGptCdpUrl()), {
      signal: AbortSignal.timeout(1_000)
    });

    if (!response.ok) {
      return [`cdp_http_${response.status}`];
    }

    const targets = await response.json() as ChromeTarget[];
    const hasChatGptTarget = targets.some((target) => {
      const url = target.url ?? "";
      return target.webSocketDebuggerUrl && (url.includes("chatgpt.com") || url.includes("chat.openai.com"));
    });

    return hasChatGptTarget ? [] : ["chatgpt_tab_not_found"];
  } catch {
    return ["cdp_unreachable"];
  }
};

const chatGptWebIssues = async (command?: string): Promise<string[]> => {
  if (!command) {
    return ["bridge_command_not_configured"];
  }

  if (!chatGptModelConfirmed()) {
    return ["model_not_confirmed"];
  }

  return chatGptCdpIssues();
};

const providerIssues = (
  provider: ProviderDescriptor,
  implemented: boolean,
  providerSpecificIssues: string[],
  command?: string,
  commandFound?: boolean
): string[] => [
  ...(provider.enabled ? [] : ["provider_disabled"]),
  ...(implemented ? [] : ["provider_not_implemented"]),
  ...providerSpecificIssues,
  ...(commandFound === false ? ["command_not_found"] : [])
];

const roleIssues = (
  role: RuntimeRole,
  assignment: RoleAssignment,
  provider: ProviderDescriptor | undefined,
  implemented: boolean,
  providerSpecificIssues: string[],
  command?: string,
  commandFound?: boolean
): string[] => [
  ...(provider ? [] : [`provider_not_configured:${assignment.provider}`]),
  ...(provider?.enabled === false ? ["provider_disabled"] : []),
  ...(implemented ? [] : ["provider_not_implemented"]),
  ...providerSpecificIssues,
  ...(provider && !modelConfigured(provider, assignment) ? [`model_not_configured:${assignment.model}`] : []),
  ...(commandFound === false ? ["command_not_found"] : [])
];

export const inspectRuntimeHealth = async (config: TheHoodConfig): Promise<RuntimeHealthReport> => {
  const providers = listProviders(config);
  const commandChecks = new Map<string, boolean>();
  const providerIssueChecks = new Map<string, string[]>();

  for (const provider of providers) {
    const command = commandForProvider(provider.id);
    if (command) {
      commandChecks.set(provider.id, await commandExists(command));
    }

    providerIssueChecks.set(
      provider.id,
      provider.id === "chatgpt-web" ? await chatGptWebIssues(command) : bridgeIssues(provider.id, command)
    );
  }

  const providerHealth = providers.map((provider): ProviderHealth => {
    const implemented = implementedProviderIds.has(provider.id);
    const command = commandForProvider(provider.id);
    const commandFound = command ? commandChecks.get(provider.id) ?? false : undefined;
    const providerSpecificIssues = providerIssueChecks.get(provider.id) ?? [];

    return {
      id: provider.id,
      enabled: provider.enabled,
      implemented,
      models: provider.models,
      ...(command ? { command } : {}),
      ...(commandFound === undefined ? {} : { commandFound }),
      issues: providerIssues(provider, implemented, providerSpecificIssues, command, commandFound)
    };
  });

  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const roleHealth = Object.entries(config.roles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, assignment]): RoleHealth => {
      const provider = providerById.get(assignment.provider);
      const implemented = implementedProviderIds.has(assignment.provider);
      const command = commandForProvider(assignment.provider);
      const commandFound = commandChecks.get(assignment.provider);
      const providerSpecificIssues = providerIssueChecks.get(assignment.provider) ?? [];

      return {
        role: role as RuntimeRole,
        assignment,
        providerEnabled: provider?.enabled ?? false,
        providerImplemented: implemented,
        modelConfigured: modelConfigured(provider, assignment),
        ...(commandFound === undefined ? {} : { commandFound }),
        issues: roleIssues(role as RuntimeRole, assignment, provider, implemented, providerSpecificIssues, command, commandFound)
      };
    });

  return {
    providers: providerHealth,
    roles: roleHealth
  };
};
