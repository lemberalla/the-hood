import { builtinProviders } from "./defaults.js";
import { providerAccessModes } from "./types.js";
import {
  codexCliKnownAliasModels,
  discoverCodexCliModels,
  type CodexCliModelDiscovery
} from "../providers/codexCliModels.js";
import type { ProviderAccessMode, ProviderConfig, TheHoodConfig } from "./types.js";

export type ProviderModelPolicy = "listed" | "passthrough" | "discovered";

export interface ProviderDescriptor extends ProviderConfig {
  id: string;
  source: "builtin" | "config";
  accessModes: ProviderAccessMode[];
  defaultAccessMode: ProviderAccessMode;
  modelPolicy: ProviderModelPolicy;
  modelDiscovery?: CodexCliModelDiscovery;
}

const defaultAccessModesByProvider = new Map<string, ProviderAccessMode[]>([
  ["chatgpt-web", ["agent-bridge", "mcp-connector"]],
  ["chatgpt-atlas", ["agent-bridge"]],
  ["openai-api", ["api-agent"]],
  ["anthropic-api", ["api-agent"]],
  ["codex-cli", ["agent-bridge"]],
  ["claude-code", ["agent-bridge"]],
  ["stub", ["agent-bridge"]],
  ["local", ["agent-bridge", "api-agent"]]
]);

const isProviderAccessMode = (value: string): value is ProviderAccessMode =>
  (providerAccessModes as readonly string[]).includes(value);

const normalizeAccessModes = (id: string, provider: ProviderConfig): ProviderAccessMode[] => {
  const configured = provider.accessModes?.filter(isProviderAccessMode) ?? [];
  if (configured.length > 0) {
    return Array.from(new Set(configured));
  }

  return [...(defaultAccessModesByProvider.get(id) ?? ["agent-bridge"])];
};

const normalizeDefaultAccessMode = (
  provider: ProviderConfig,
  accessModes: ProviderAccessMode[]
): ProviderAccessMode =>
  provider.defaultAccessMode && accessModes.includes(provider.defaultAccessMode)
    ? provider.defaultAccessMode
    : accessModes[0] ?? "agent-bridge";

const modelPolicyForProvider = (id: string, provider: ProviderConfig): ProviderModelPolicy => {
  if (id === "codex-cli") {
    return "discovered";
  }

  return provider.models.includes("configured") ? "passthrough" : "listed";
};

export const listProviders = (config: TheHoodConfig): ProviderDescriptor[] =>
  Object.entries(config.providers)
    .map(([id, provider]) => {
      const source: ProviderDescriptor["source"] = Object.hasOwn(builtinProviders, id)
        ? "builtin"
        : "config";
      const accessModes = normalizeAccessModes(id, provider);

      return {
        id,
        ...provider,
        source,
        accessModes,
        defaultAccessMode: normalizeDefaultAccessMode(provider, accessModes),
        modelPolicy: modelPolicyForProvider(id, provider)
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const withRuntimeModels = (provider: ProviderDescriptor): ProviderDescriptor => {
  if (provider.id !== "codex-cli" || !provider.enabled) {
    return provider;
  }

  const modelDiscovery = discoverCodexCliModels();
  const discoveredModels = modelDiscovery.models.map((model) => model.slug);

  return {
    ...provider,
    models: unique([...provider.models, ...discoveredModels, ...codexCliKnownAliasModels()]),
    modelDiscovery
  };
};

export const listProvidersWithRuntimeModels = (config: TheHoodConfig): ProviderDescriptor[] =>
  listProviders(config).map(withRuntimeModels);
