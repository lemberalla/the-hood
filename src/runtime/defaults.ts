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
    accessModes: ["agent-bridge", "mcp-connector"],
    defaultAccessMode: "agent-bridge",
    browserProfile: "default"
  },
  "openai-api": {
    enabled: false,
    models: ["configured"],
    accessModes: ["api-agent"],
    defaultAccessMode: "api-agent",
    apiKeyEnv: "OPENAI_API_KEY"
  },
  "anthropic-api": {
    enabled: false,
    models: ["claude-opus", "claude-sonnet"],
    accessModes: ["api-agent"],
    defaultAccessMode: "api-agent",
    apiKeyEnv: "ANTHROPIC_API_KEY"
  },
  "codex-cli": {
    enabled: true,
    models: ["default"],
    accessModes: ["agent-bridge"],
    defaultAccessMode: "agent-bridge"
  },
  "claude-code": {
    enabled: true,
    models: ["default"],
    accessModes: ["agent-bridge"],
    defaultAccessMode: "agent-bridge"
  },
  stub: {
    enabled: true,
    models: ["orchestrator", "planner", "researcher", "implementer", "verifier", "critic"],
    accessModes: ["agent-bridge"],
    defaultAccessMode: "agent-bridge"
  },
  local: {
    enabled: false,
    models: ["default"],
    accessModes: ["agent-bridge", "api-agent"],
    defaultAccessMode: "agent-bridge"
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
    provider: "claude-code",
    model: "default"
  },
  critic: {
    provider: "claude-code",
    model: "default"
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
