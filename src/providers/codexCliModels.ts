import { spawnSync } from "node:child_process";
import path from "node:path";

export interface CodexCliDiscoveredModel {
  slug: string;
  displayName?: string;
  visibility?: string;
  defaultReasoningLevel?: string;
  supportedReasoningLevels: string[];
  serviceTiers: string[];
  additionalSpeedTiers: string[];
}

export interface CodexCliModelDiscovery {
  status: "available" | "unavailable";
  command: string;
  source: "codex_debug_models";
  models: CodexCliDiscoveredModel[];
  issues: string[];
}

const maxCatalogBytes = 64 * 1024 * 1024;
const nodeScriptExtensions = new Set([".js", ".mjs", ".cjs"]);

const friendlyModelAliases: Record<string, string[]> = {
  spark: ["codex-spark"]
};

const friendlyModelFallbacks: Record<string, string> = {
  spark: "gpt-5.3-codex-spark"
};

export const codexCliUsesDefaultModel = (model: string): boolean =>
  model === "default" || model === "configured";

export const codexCliCommand = (): string =>
  process.env.THEHOOD_CODEX_COMMAND ?? "codex";

const launchCommand = (command: string): { command: string; args: string[] } =>
  nodeScriptExtensions.has(path.extname(command))
    ? { command: process.execPath, args: [command] }
    : { command, args: [] };

const normalizeModelText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const stringField = (value: unknown, field: string): string | undefined =>
  value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)[field] === "string"
    ? (value as Record<string, string>)[field]
    : undefined;

const stringArrayField = (value: unknown, field: string): string[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const raw = (value as Record<string, unknown>)[field];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
};

const reasoningLevels = (value: unknown): string[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const raw = (value as Record<string, unknown>).supported_reasoning_levels;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => stringField(item, "effort"))
    .filter((item): item is string => Boolean(item));
};

const serviceTierIds = (value: unknown): string[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const raw = (value as Record<string, unknown>).service_tiers;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => stringField(item, "id"))
    .filter((item): item is string => Boolean(item));
};

const sanitizeModel = (value: unknown): CodexCliDiscoveredModel | undefined => {
  const slug = stringField(value, "slug");
  if (!slug) {
    return undefined;
  }

  const displayName = stringField(value, "display_name");
  const visibility = stringField(value, "visibility");
  const defaultReasoningLevel = stringField(value, "default_reasoning_level");

  return {
    slug,
    ...(displayName ? { displayName } : {}),
    ...(visibility ? { visibility } : {}),
    ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
    supportedReasoningLevels: reasoningLevels(value),
    serviceTiers: serviceTierIds(value),
    additionalSpeedTiers: stringArrayField(value, "additional_speed_tiers")
  };
};

export const discoverCodexCliModels = (command = codexCliCommand()): CodexCliModelDiscovery => {
  const launch = launchCommand(command);
  const result = spawnSync(launch.command, [...launch.args, "debug", "models"], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: maxCatalogBytes
  });

  if (result.error) {
    return {
      status: "unavailable",
      command,
      source: "codex_debug_models",
      models: [],
      issues: [`model_discovery_error:${result.error.message}`]
    };
  }

  if (result.status !== 0) {
    return {
      status: "unavailable",
      command,
      source: "codex_debug_models",
      models: [],
      issues: [`model_discovery_exit_${result.status ?? "unknown"}`]
    };
  }

  try {
    const parsed = JSON.parse(result.stdout) as { models?: unknown };
    const models = Array.isArray(parsed.models)
      ? parsed.models
        .map(sanitizeModel)
        .filter((model): model is CodexCliDiscoveredModel => Boolean(model))
      : [];

    return {
      status: "available",
      command,
      source: "codex_debug_models",
      models,
      issues: []
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "unavailable",
      command,
      source: "codex_debug_models",
      models: [],
      issues: [`model_discovery_parse_failed:${message}`]
    };
  }
};

export const resolveCodexCliModelFromCatalog = (
  model: string,
  models: CodexCliDiscoveredModel[]
): string | undefined => {
  const normalizedModel = normalizeModelText(model);
  const exact = models.find((candidate) =>
    candidate.slug === model ||
    normalizeModelText(candidate.slug) === normalizedModel ||
    (candidate.displayName ? normalizeModelText(candidate.displayName) === normalizedModel : false)
  );

  if (exact) {
    return exact.slug;
  }

  const patterns = friendlyModelAliases[normalizedModel] ?? [];
  return models.find((candidate) =>
    patterns.some((pattern) =>
      normalizeModelText(candidate.slug).includes(pattern) ||
      (candidate.displayName ? normalizeModelText(candidate.displayName).includes(pattern) : false)
    )
  )?.slug;
};

export const resolveCodexCliModel = (
  model: string,
  discovery = discoverCodexCliModels()
): string =>
  codexCliUsesDefaultModel(model)
    ? "default"
    : resolveCodexCliModelFromCatalog(model, discovery.models) ??
      friendlyModelFallbacks[normalizeModelText(model)] ??
      model;

export const codexCliModelAvailable = (
  model: string,
  discovery: CodexCliModelDiscovery
): boolean | undefined => {
  if (codexCliUsesDefaultModel(model)) {
    return true;
  }

  if (discovery.status !== "available") {
    return undefined;
  }

  const resolvedFromCatalog = resolveCodexCliModelFromCatalog(model, discovery.models);
  if (resolvedFromCatalog) {
    return true;
  }

  const normalizedModel = normalizeModelText(model);
  return Boolean(
    friendlyModelFallbacks[normalizedModel] ||
    Object.values(friendlyModelFallbacks).some((fallback) => normalizeModelText(fallback) === normalizedModel)
  );
};

export const codexCliKnownAliasModels = (): string[] =>
  [...new Set(Object.values(friendlyModelFallbacks))];
