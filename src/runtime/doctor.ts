import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectBrowser } from "./browserManager.js";
import { listProvidersWithRuntimeModels } from "./providers.js";
import { runtimeInfo, type RuntimeInfo } from "./runtimeInfo.js";
import { resolveChatGptAtlasBridgeCommand, chatGptAtlasBridgeBin } from "../providers/chatgptAtlas.js";
import { codexCliModelAvailable, resolveCodexCliModel, type CodexCliModelDiscovery } from "../providers/codexCliModels.js";
import { resolveChatGptWebBridgeCommand } from "../providers/chatgptWeb.js";
import { isNodeScriptCommand } from "../providers/localCommand.js";
import type { ProviderDescriptor, ProviderModelPolicy } from "./providers.js";
import type { ProviderAccessMode, RoleAssignment, RuntimeRole, TheHoodConfig } from "./types.js";

export interface ProviderHealth {
  id: string;
  enabled: boolean;
  implemented: boolean;
  models: string[];
  accessModes: ProviderAccessMode[];
  defaultAccessMode: ProviderAccessMode;
  modelPolicy: ProviderModelPolicy;
  modelDiscovery?: CodexCliModelDiscovery;
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
  modelPolicy: ProviderModelPolicy;
  modelStatus: "listed" | "passthrough" | "available" | "unavailable" | "unknown";
  modelAvailable?: boolean;
  resolvedModel?: string;
  commandFound?: boolean;
  issues: string[];
}

export interface RuntimeHealthReport {
  runtime: RuntimeInfo;
  providers: ProviderHealth[];
  roles: RoleHealth[];
}

const implementedProviderIds = new Set(["stub", "chatgpt-web", "chatgpt-atlas", "codex-cli", "claude-code"]);

const commandForProvider = (providerId: string): string | undefined => {
  if (providerId === "chatgpt-web") {
    return process.env.THEHOOD_CHATGPT_WEB_COMMAND;
  }

  if (providerId === "chatgpt-atlas") {
    return process.env.THEHOOD_CHATGPT_ATLAS_COMMAND?.trim() || chatGptAtlasBridgeBin;
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

const canRead = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveBridgeCommand = (command: string): string =>
  resolveChatGptAtlasBridgeCommand(resolveChatGptWebBridgeCommand(command));

const commandExists = async (command: string): Promise<boolean> => {
  const resolvedCommand = resolveBridgeCommand(command);
  if (isNodeScriptCommand(resolvedCommand)) {
    return canRead(resolvedCommand);
  }

  if (resolvedCommand !== command) {
    return commandExists(resolvedCommand);
  }

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

const modelStatus = (
  provider: ProviderDescriptor | undefined,
  assignment: RoleAssignment,
  available?: boolean
): RoleHealth["modelStatus"] => {
  if (!provider || !modelConfigured(provider, assignment)) {
    return "unavailable";
  }

  if (provider.id === "codex-cli") {
    if (available === true) {
      return "available";
    }

    if (available === false) {
      return "unavailable";
    }

    return "unknown";
  }

  if (provider.models.includes(assignment.model)) {
    return "listed";
  }

  return provider.modelPolicy === "passthrough" ? "passthrough" : "unknown";
};

const modelAvailability = (
  provider: ProviderDescriptor | undefined,
  assignment: RoleAssignment
): { available?: boolean; resolvedModel?: string } => {
  if (provider?.id !== "codex-cli" || !provider.modelDiscovery) {
    return {};
  }

  const available = codexCliModelAvailable(assignment.model, provider.modelDiscovery);
  const resolvedModel = provider.modelDiscovery.status === "available"
    ? resolveCodexCliModel(assignment.model, provider.modelDiscovery)
    : undefined;

  return {
    ...(available === undefined ? {} : { available }),
    ...(resolvedModel ? { resolvedModel } : {})
  };
};

const bridgeIssues = (providerId: string, command?: string): string[] =>
  (providerId === "chatgpt-web" || providerId === "chatgpt-atlas") && !command
    ? ["bridge_command_not_configured"]
    : [];

const chatGptAtlasTargetConfirmed = (): boolean =>
  process.env.THEHOOD_CHATGPT_ATLAS_TARGET_CONFIRMED === "1";

const chatGptAtlasFakeTransportConfigured = (): boolean =>
  process.env.THEHOOD_CHATGPT_ATLAS_TRANSPORT === "fake" ||
  Boolean(process.env.THEHOOD_CHATGPT_ATLAS_FAKE_RESPONSE) ||
  Boolean(process.env.THEHOOD_CHATGPT_ATLAS_FAKE_RESPONSE_FILE);

const chatGptAtlasIssues = (command?: string): string[] => {
  if (!command) {
    return ["bridge_command_not_configured"];
  }

  if (chatGptAtlasFakeTransportConfigured()) {
    return [];
  }

  return [
    ...(chatGptAtlasTargetConfirmed() ? [] : ["atlas_target_not_confirmed"]),
    ...(process.env.THEHOOD_CHATGPT_ATLAS_COMPUTER_USE_COMMAND ? [] : ["computer_use_command_not_configured"])
  ];
};

const chatGptModelConfirmed = (): boolean =>
  process.env.THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED === "1" ||
  process.env.THEHOOD_CHATGPT_WEB_ALLOW_UNVERIFIED_MODEL === "1";

const chatGptCdpUrl = (): string => process.env.THEHOOD_CHATGPT_WEB_CDP_URL ?? "http://127.0.0.1:9222";

const chatGptCdpIssues = async (): Promise<string[]> => {
  const status = await inspectBrowser({ cdpUrl: chatGptCdpUrl() });
  return status.issues;
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
  ...(provider.modelDiscovery?.status === "unavailable" ? provider.modelDiscovery.issues : []),
  ...providerSpecificIssues,
  ...(commandFound === false ? ["command_not_found"] : [])
];

const roleIssues = (
  role: RuntimeRole,
  assignment: RoleAssignment,
  provider: ProviderDescriptor | undefined,
  implemented: boolean,
  providerSpecificIssues: string[],
  modelAvailable?: boolean,
  command?: string,
  commandFound?: boolean
): string[] => [
  ...(provider ? [] : [`provider_not_configured:${assignment.provider}`]),
  ...(provider?.enabled === false ? ["provider_disabled"] : []),
  ...(implemented ? [] : ["provider_not_implemented"]),
  ...providerSpecificIssues,
  ...(provider && !modelConfigured(provider, assignment) ? [`model_not_configured:${assignment.model}`] : []),
  ...(modelAvailable === false ? [`model_not_available:${assignment.model}`] : []),
  ...(commandFound === false ? ["command_not_found"] : [])
];

export const inspectRuntimeHealth = async (config: TheHoodConfig): Promise<RuntimeHealthReport> => {
  const providers = listProvidersWithRuntimeModels(config);
  const commandChecks = new Map<string, boolean>();
  const providerIssueChecks = new Map<string, string[]>();

  for (const provider of providers) {
    const command = commandForProvider(provider.id);
    if (command) {
      commandChecks.set(provider.id, await commandExists(command));
    }

    providerIssueChecks.set(
      provider.id,
      provider.id === "chatgpt-web"
        ? await chatGptWebIssues(command)
        : provider.id === "chatgpt-atlas"
          ? chatGptAtlasIssues(command)
          : bridgeIssues(provider.id, command)
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
      accessModes: provider.accessModes,
      defaultAccessMode: provider.defaultAccessMode,
      modelPolicy: provider.modelPolicy,
      ...(provider.modelDiscovery ? { modelDiscovery: provider.modelDiscovery } : {}),
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
      const availability = modelAvailability(provider, assignment);
      const status = modelStatus(provider, assignment, availability.available);

      return {
        role: role as RuntimeRole,
        assignment,
        providerEnabled: provider?.enabled ?? false,
        providerImplemented: implemented,
        modelConfigured: modelConfigured(provider, assignment),
        modelPolicy: provider?.modelPolicy ?? "listed",
        modelStatus: status,
        ...(availability.available === undefined ? {} : { modelAvailable: availability.available }),
        ...(availability.resolvedModel ? { resolvedModel: availability.resolvedModel } : {}),
        ...(commandFound === undefined ? {} : { commandFound }),
        issues: roleIssues(
          role as RuntimeRole,
          assignment,
          provider,
          implemented,
          providerSpecificIssues,
          availability.available,
          command,
          commandFound
        )
      };
    });

  return {
    runtime: runtimeInfo,
    providers: providerHealth,
    roles: roleHealth
  };
};
