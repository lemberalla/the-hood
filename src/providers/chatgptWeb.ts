import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFallbackAgentResponse,
  normalizeLocalAgentCommandSpec,
  runLocalAgentCommand
} from "./localCommand.js";
import type { LocalAgentCommandContext } from "./localCommand.js";
import type { AgentRequest, ProviderAdapter } from "./types.js";

const chatGptWebBridgeBin = "thehood-chatgpt-web-bridge";

const bridgeCommand = (): string | undefined => process.env.THEHOOD_CHATGPT_WEB_COMMAND;

export const bundledChatGptWebBridgePath = (): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bridges", "chatgptWebBridge.js");

export const resolveChatGptWebBridgeCommand = (command: string): string =>
  command === chatGptWebBridgeBin ? bundledChatGptWebBridgePath() : command;

const buildChatGptWebArgs = (request: AgentRequest, context: LocalAgentCommandContext): string[] => [
  "--model",
  request.assignment.model,
  "--schema",
  context.schemaPath
];

export const chatGptWebProvider: ProviderAdapter = {
  id: "chatgpt-web",
  async runAgent(request) {
    const command = bridgeCommand();

    if (!command) {
      return createFallbackAgentResponse(request, {
        status: "blocked",
        summary:
          "ChatGPT Web bridge command is not configured. Set THEHOOD_CHATGPT_WEB_COMMAND to an executable that uses the user's authenticated ChatGPT session and returns the AgentResponse JSON envelope."
      });
    }

    return runLocalAgentCommand(request, normalizeLocalAgentCommandSpec({
      providerId: "chatgpt-web",
      command: resolveChatGptWebBridgeCommand(command),
      commandLabel: command,
      buildArgs: buildChatGptWebArgs
    }));
  }
};
