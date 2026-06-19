import fs from "node:fs/promises";
import path from "node:path";
import { createDefaultConfig } from "./defaults.js";
import { InputError } from "./errors.js";
import { getProjectPaths } from "./paths.js";
import type { RoleMap, TheHoodConfig } from "./types.js";

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
  providers: {
    ...base.providers,
    ...(override.providers ?? {})
  },
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
  await fs.mkdir(path.dirname(paths.configPath), { recursive: true });
  await fs.writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return paths.configPath;
};

export const initConfig = async (repoPath: string): Promise<{ configPath: string; created: boolean }> => {
  const paths = getProjectPaths(repoPath);

  try {
    await fs.access(paths.configPath);
    return {
      configPath: paths.configPath,
      created: false
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
    created: true
  };
};
