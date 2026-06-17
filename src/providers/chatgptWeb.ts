import { createFallbackAgentResponse, runLocalAgentCommand } from "./localCommand.js";
import type { LocalAgentCommandContext } from "./localCommand.js";
import type { AgentRequest, ProviderAdapter } from "./types.js";

const bridgeCommand = (): string | undefined => process.env.THEHOOD_CHATGPT_WEB_COMMAND;

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

    return runLocalAgentCommand(request, {
      providerId: "chatgpt-web",
      command,
      buildArgs: buildChatGptWebArgs
    });
  }
};
