import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../runtime/config.js";
import {
  createFallbackAgentResponse,
  normalizeLocalAgentCommandSpec,
  runLocalAgentCommand
} from "./localCommand.js";
import type { LocalAgentCommandContext } from "./localCommand.js";
import type { AgentRequest, ProviderAdapter } from "./types.js";

export const chatGptAtlasBridgeBin = "thehood-chatgpt-atlas-bridge";

const atlasCommand = (): string => process.env.THEHOOD_CHATGPT_ATLAS_COMMAND?.trim() || chatGptAtlasBridgeBin;

export const bundledChatGptAtlasBridgePath = (): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bridges", "chatgptAtlasBridge.js");

export const resolveChatGptAtlasBridgeCommand = (command: string): string =>
  command === chatGptAtlasBridgeBin ? bundledChatGptAtlasBridgePath() : command;

const atlasEnabled = async (repoPath: string): Promise<boolean> => {
  const config = await loadConfig(repoPath);

  return config.providers["chatgpt-atlas"]?.enabled === true;
};

const buildChatGptAtlasArgs = (request: AgentRequest, context: LocalAgentCommandContext): string[] => [
  "--model",
  request.assignment.model,
  "--schema",
  context.schemaPath,
  "--target",
  "ChatGPT Atlas",
  "--transport",
  "computer-use"
];

export const chatGptAtlasProvider: ProviderAdapter = {
  id: "chatgpt-atlas",
  async runAgent(request) {
    const command = atlasCommand();

    if (!(await atlasEnabled(request.run.repoPath))) {
      return createFallbackAgentResponse(request, {
        status: "blocked",
        summary:
          "ChatGPT Atlas provider is disabled in TheHood config. Atlas ships enabled by default; remove the stale provider override or run thehood pro-route set atlas --repo <path> after configuring a confirmed Atlas target and trusted local Computer Use controller."
      });
    }

    return runLocalAgentCommand(request, normalizeLocalAgentCommandSpec({
      providerId: "chatgpt-atlas",
      command: resolveChatGptAtlasBridgeCommand(command),
      commandLabel: command,
      buildArgs: buildChatGptAtlasArgs
    }));
  }
};
