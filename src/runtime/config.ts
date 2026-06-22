import fs from "node:fs/promises";
import path from "node:path";
import { createDefaultConfig } from "./defaults.js";
import { InputError } from "./errors.js";
import { ensureLocalStateIgnored, type LocalStateIgnoreResult } from "./localStateIgnore.js";
import { getProjectPaths } from "./paths.js";
import { chatGptProRoutes } from "./types.js";
import type { ProviderConfig, RoleMap, RuntimePreferences, TheHoodConfig } from "./types.js";

export interface InitConfigResult {
  configPath: string;
  created: boolean;
  localStateIgnore: LocalStateIgnoreResult;
}

const readJsonFile = async <T>(filePath: string): Promise<T> => {
  const raw = await fs.readFile(filePath, "utf8");

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(`Invalid JSON in ${filePath}: ${message}`);
  }
};

const mergeRoles = (base: RoleMap, override: RoleMap | undefined): RoleMap => ({
  ...base,
  ...(override ?? {})
});

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const mergeProvider = (
  base: ProviderConfig | undefined,
  override: ProviderConfig
): ProviderConfig =>
  base
    ? {
        ...base,
        ...override,
        models: unique([...base.models, ...override.models]),
        accessModes: unique([...(base.accessModes ?? []), ...(override.accessModes ?? [])])
      }
    : override;

const isLegacyDisabledChatGptAtlasSeed = (providerId: string, provider: ProviderConfig): boolean =>
  providerId === "chatgpt-atlas" &&
  provider.enabled === false &&
  provider.defaultAccessMode === "agent-bridge" &&
  JSON.stringify(provider.models) === JSON.stringify(["chatgpt-pro", "configured"]) &&
  JSON.stringify(provider.accessModes ?? []) === JSON.stringify(["agent-bridge"]) &&
  provider.apiKeyEnv === undefined &&
  provider.browserProfile === undefined;

const mergeProviders = (
  base: TheHoodConfig["providers"],
  override: TheHoodConfig["providers"] | undefined
): TheHoodConfig["providers"] => {
  if (!override) {
    return base;
  }

  const merged = { ...base };

  for (const [providerId, provider] of Object.entries(override)) {
    const migratedProvider = isLegacyDisabledChatGptAtlasSeed(providerId, provider)
      ? { ...provider, enabled: true }
      : provider;
    merged[providerId] = mergeProvider(base[providerId], migratedProvider);
  }

  return merged;
};

const mergePreferences = (
  base: RuntimePreferences,
  override: Partial<RuntimePreferences> | undefined
): RuntimePreferences => {
  const chatGptProRoute = override?.chatGptProRoute ?? base.chatGptProRoute;

  if (!(chatGptProRoutes as readonly string[]).includes(chatGptProRoute)) {
    throw new InputError(`preferences.chatGptProRoute must be one of: ${chatGptProRoutes.join(", ")}.`);
  }

  return {
    ...base,
    ...(override ?? {}),
    chatGptProRoute
  };
};

const mergeConfig = (base: TheHoodConfig, override: Partial<TheHoodConfig>): TheHoodConfig => ({
  version: 1,
  defaults: {
    ...base.defaults,
    ...(override.defaults ?? {}),
    protectedTestPaths:
      override.defaults?.protectedTestPaths ?? base.defaults.protectedTestPaths
  },
  approvalPolicy: {
    mode:
      override.approvalPolicy?.mode ??
      override.approvalPolicy?.externalTransfers?.mode ??
      base.approvalPolicy.mode,
    externalTransfers: {
      ...base.approvalPolicy.externalTransfers,
      ...(override.approvalPolicy?.externalTransfers ?? {}),
      rules:
        override.approvalPolicy?.externalTransfers?.rules ??
        base.approvalPolicy.externalTransfers.rules
    }
  },
  preferences: mergePreferences(base.preferences, override.preferences),
  providers: mergeProviders(base.providers, override.providers),
  roles: mergeRoles(base.roles, override.roles)
});

export const loadConfig = async (repoPath: string): Promise<TheHoodConfig> => {
  const paths = getProjectPaths(repoPath);
  const defaults = createDefaultConfig();

  try {
    const loaded = await readJsonFile<Partial<TheHoodConfig>>(paths.configPath);
    return mergeConfig(defaults, loaded);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaults;
    }

    throw error;
  }
};

export const writeConfig = async (repoPath: string, config: TheHoodConfig): Promise<string> => {
  const paths = getProjectPaths(repoPath);
  await ensureLocalStateIgnored(repoPath);
  await fs.mkdir(path.dirname(paths.configPath), { recursive: true });
  await fs.writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return paths.configPath;
};

export const initConfig = async (repoPath: string): Promise<InitConfigResult> => {
  const paths = getProjectPaths(repoPath);
  const localStateIgnore = await ensureLocalStateIgnored(repoPath);

  try {
    await fs.access(paths.configPath);
    return {
      configPath: paths.configPath,
      created: false,
      localStateIgnore
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const configPath = await writeConfig(repoPath, createDefaultConfig());
  await fs.mkdir(paths.runsDir, { recursive: true });
  await fs.mkdir(paths.artifactsDir, { recursive: true });

  return {
    configPath,
    created: true,
    localStateIgnore
  };
};
