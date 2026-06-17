import type { ProviderConfig, RoleMap, TheHoodConfig } from "./types.js";

export const defaultProtectedTestPaths = [
  "**/test/**",
  "**/tests/**",
  "**/*.spec.*",
  "**/*.test.*",
  "**/__snapshots__/**",
  "**/fixtures/**",
  "**/evals/**"
];

export const builtinProviders: Record<string, ProviderConfig> = {
  "chatgpt-web": {
    enabled: true,
    models: ["chatgpt-pro"],
    browserProfile: "default"
  },
  "openai-api": {
    enabled: false,
    models: ["configured"],
    apiKeyEnv: "OPENAI_API_KEY"
  },
  "anthropic-api": {
    enabled: false,
    models: ["claude-opus", "claude-sonnet"],
    apiKeyEnv: "ANTHROPIC_API_KEY"
  },
  "codex-cli": {
    enabled: true,
    models: ["default"]
  },
  "claude-code": {
    enabled: true,
    models: ["default"]
  },
  local: {
    enabled: false,
    models: ["default"]
  }
};

export const defaultRoles: RoleMap = {
  orchestrator: {
    provider: "chatgpt-web",
    model: "chatgpt-pro"
  },
  implementer: {
    provider: "codex-cli",
    model: "default"
  },
  verifier: {
    provider: "anthropic-api",
    model: "claude-opus"
  },
  critic: {
    provider: "anthropic-api",
    model: "claude-sonnet"
  }
};

export const createDefaultConfig = (): TheHoodConfig => ({
  version: 1,
  defaults: {
    maxIterations: 5,
    editRequiresApproval: true,
    dependencyInstallRequiresApproval: true,
    networkRequiresApproval: true,
    protectedTestPaths: [...defaultProtectedTestPaths]
  },
  providers: structuredClone(builtinProviders),
  roles: structuredClone(defaultRoles)
});

