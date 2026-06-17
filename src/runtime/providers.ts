import { builtinProviders } from "./defaults.js";
import type { ProviderConfig, TheHoodConfig } from "./types.js";

export interface ProviderDescriptor extends ProviderConfig {
  id: string;
  source: "builtin" | "config";
}

export const listProviders = (config: TheHoodConfig): ProviderDescriptor[] =>
  Object.entries(config.providers)
    .map(([id, provider]) => {
      const source: ProviderDescriptor["source"] = Object.hasOwn(builtinProviders, id)
        ? "builtin"
        : "config";

      return {
        id,
        ...provider,
        source
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
