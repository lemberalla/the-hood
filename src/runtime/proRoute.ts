import { InputError } from "./errors.js";
import type { RuntimeHealthReport } from "./doctor.js";
import { chatGptProRoutes, type ChatGptProRoute, type TheHoodConfig } from "./types.js";

export type ChatGptProRouteAlias =
  | ChatGptProRoute
  | "chrome"
  | "web"
  | "chatgpt-web"
  | "atlas"
  | "chatgpt-atlas"
  | "mcp";

export type ChatGptProRouteStatus = "ready" | "not_ready" | "handoff";

export interface ChatGptProRouteCandidate {
  route: ChatGptProRoute;
  label: string;
  provider?: string;
  accessMode: "agent-bridge" | "mcp-connector";
  status: ChatGptProRouteStatus;
  issues: string[];
  command?: string;
  commandFound?: boolean;
  setCommand: string;
}

export interface ChatGptProRouteResolution {
  preference: ChatGptProRoute;
  status: "selected" | "user_choice_required";
  selectedRoute?: ChatGptProRoute;
  reason: string;
  candidates: ChatGptProRouteCandidate[];
  prompt: string;
}

const routeLabels: Record<ChatGptProRoute, string> = {
  auto: "Ask every time",
  "chatgpt-web": "Chrome / ChatGPT Web bridge",
  "chatgpt-atlas": "Atlas / Computer Use",
  "mcp-connector": "MCP connector"
};

const routeAliases: Record<string, ChatGptProRoute> = {
  auto: "auto",
  chrome: "chatgpt-web",
  web: "chatgpt-web",
  "chatgpt-web": "chatgpt-web",
  atlas: "chatgpt-atlas",
  "chatgpt-atlas": "chatgpt-atlas",
  mcp: "mcp-connector",
  "mcp-connector": "mcp-connector"
};

export const parseChatGptProRoute = (value: string | undefined): ChatGptProRoute => {
  const normalized = value?.trim().toLowerCase();
  const route = normalized ? routeAliases[normalized] : undefined;

  if (!route) {
    throw new InputError(`ChatGPT Pro route must be one of: ${chatGptProRoutes.join(", ")}, chrome, atlas, or mcp.`);
  }

  return route;
};

export const chatGptProRouteLabel = (route: ChatGptProRoute): string => routeLabels[route];

export const applyChatGptProRoutePreference = (
  config: TheHoodConfig,
  route: ChatGptProRoute
): TheHoodConfig => {
  const directProvider = route === "chatgpt-web" || route === "chatgpt-atlas"
    ? config.providers[route]
    : undefined;

  return {
    ...config,
    preferences: {
      ...config.preferences,
      chatGptProRoute: route
    },
    providers: directProvider
      ? {
          ...config.providers,
          [route]: {
            ...directProvider,
            enabled: true
          }
        }
      : config.providers
  };
};

const providerCandidate = (
  route: Extract<ChatGptProRoute, "chatgpt-web" | "chatgpt-atlas">,
  health: RuntimeHealthReport,
  repoPath: string
): ChatGptProRouteCandidate => {
  const provider = health.providers.find((candidate) => candidate.id === route);
  const issues = provider?.issues ?? [`provider_not_configured:${route}`];
  const ready = Boolean(provider?.enabled && provider.implemented && issues.length === 0);

  return {
    route,
    label: routeLabels[route],
    provider: route,
    accessMode: "agent-bridge",
    status: ready ? "ready" : "not_ready",
    issues,
    ...(provider?.command ? { command: provider.command } : {}),
    ...(provider?.commandFound === undefined ? {} : { commandFound: provider.commandFound }),
    setCommand: `thehood pro-route set ${route === "chatgpt-web" ? "chrome" : "atlas"} --repo ${JSON.stringify(repoPath)}`
  };
};

const mcpCandidate = (repoPath: string): ChatGptProRouteCandidate => ({
  route: "mcp-connector",
  label: routeLabels["mcp-connector"],
  accessMode: "mcp-connector",
  status: "handoff",
  issues: ["connector_readiness_not_verified_by_thehood"],
  setCommand: `thehood pro-route set mcp --repo ${JSON.stringify(repoPath)}`
});

export const chatGptProRouteCandidates = (
  health: RuntimeHealthReport,
  repoPath: string
): ChatGptProRouteCandidate[] => [
  providerCandidate("chatgpt-web", health, repoPath),
  providerCandidate("chatgpt-atlas", health, repoPath),
  mcpCandidate(repoPath)
];

export const resolveChatGptProRoute = (
  config: TheHoodConfig,
  health: RuntimeHealthReport,
  repoPath: string
): ChatGptProRouteResolution => {
  const preference = config.preferences.chatGptProRoute;
  const candidates = chatGptProRouteCandidates(health, repoPath);

  if (preference !== "auto") {
    return {
      preference,
      status: "selected",
      selectedRoute: preference,
      reason: `Saved ChatGPT Pro route is ${routeLabels[preference]}.`,
      candidates,
      prompt: `Use ${routeLabels[preference]} for ChatGPT Pro.`
    };
  }

  const readyDirectRoutes = candidates.filter((candidate) => candidate.accessMode === "agent-bridge" && candidate.status === "ready");
  const readySummary = readyDirectRoutes.length > 0
    ? ` Ready now: ${readyDirectRoutes.map((candidate) => candidate.label).join(", ")}.`
    : "";

  return {
    preference,
    status: "user_choice_required",
    reason: `No ChatGPT Pro route default is saved.${readySummary}`,
    candidates,
    prompt: "How should TheHood reach ChatGPT Pro: Chrome, Atlas, or MCP connector?"
  };
};
