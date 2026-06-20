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
    models: ["chatgpt-pro", "configured"],
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
    models: ["configured", "claude-opus", "claude-sonnet", "claude-haiku", "opus", "sonnet", "haiku", "mythos", "fable"],
    accessModes: ["api-agent"],
    defaultAccessMode: "api-agent",
    apiKeyEnv: "ANTHROPIC_API_KEY"
  },
  "codex-cli": {
    enabled: true,
    models: ["default", "spark", "configured"],
    accessModes: ["agent-bridge"],
    defaultAccessMode: "agent-bridge"
  },
  "claude-code": {
    enabled: true,
    models: ["default", "configured", "sonnet", "opus", "haiku", "mythos", "fable"],
    accessModes: ["agent-bridge"],
    defaultAccessMode: "agent-bridge"
  },
  stub: {
    enabled: true,
    models: ["orchestrator", "planner", "researcher", "implementer", "qa", "verifier", "critic"],
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
    provider: "codex-cli",
    model: "default"
  },
  implementer: {
    provider: "codex-cli",
    model: "default"
  },
  qa: {
    provider: "codex-cli",
    model: "spark"
  },
  verifier: {
    provider: "codex-cli",
    model: "spark"
  },
  critic: {
    provider: "codex-cli",
    model: "spark"
  }
};

export const createDefaultConfig = (): TheHoodConfig => ({
  version: 1,
  defaults: {
    maxIterations: 8,
    fanoutMaxItems: 8,
    editRequiresApproval: true,
    dependencyInstallRequiresApproval: true,
    networkRequiresApproval: true,
    protectedTestPaths: [...defaultProtectedTestPaths]
  },
  approvalPolicy: {
    mode: "manual",
    externalTransfers: {
      mode: "manual",
      maxAutoApproveBytes: 200_000,
      rules: []
    }
  },
  providers: structuredClone(builtinProviders),
  roles: structuredClone(defaultRoles)
});
