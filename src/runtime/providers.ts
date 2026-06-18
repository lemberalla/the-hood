import { builtinProviders } from "./defaults.js";
import { providerAccessModes } from "./types.js";
import type { ProviderAccessMode, ProviderConfig, TheHoodConfig } from "./types.js";

export interface ProviderDescriptor extends ProviderConfig {
  id: string;
  source: "builtin" | "config";
  accessModes: ProviderAccessMode[];
  defaultAccessMode: ProviderAccessMode;
}

const defaultAccessModesByProvider = new Map<string, ProviderAccessMode[]>([
  ["chatgpt-web", ["agent-bridge", "mcp-connector"]],
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
        defaultAccessMode: normalizeDefaultAccessMode(provider, accessModes)
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
