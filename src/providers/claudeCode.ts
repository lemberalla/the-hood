import { createLocalCommandProvider } from "./localCommand.js";
import type { LocalAgentCommandContext } from "./localCommand.js";
import type { AgentRequest } from "./types.js";

const permissionModeForRequest = (request: AgentRequest): string =>
  request.directive.toolPermissions.edit ? "default" : "plan";

const usesDefaultModel = (model: string): boolean =>
  model === "default" || model === "configured";

const toolsForRequest = (request: AgentRequest): string => {
  if (request.directive.toolPermissions.edit) {
    return "Read,Glob,Grep,Edit,MultiEdit,Write,Bash";
  }

  if (request.directive.toolPermissions.shell) {
    return "Read,Glob,Grep,Bash";
  }

  return "Read,Glob,Grep";
};

export const buildClaudeCodeArgs = (request: AgentRequest, context: LocalAgentCommandContext): string[] => {
  const args = [
    "--print",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(context.schema),
    "--no-session-persistence",
    "--permission-mode",
    permissionModeForRequest(request),
    "--tools",
    toolsForRequest(request)
  ];

  if (!usesDefaultModel(request.assignment.model)) {
    args.push("--model", request.assignment.model);
  }

  return args;
};

export const claudeCodeProvider = createLocalCommandProvider(
  "claude-code",
  process.env.THEHOOD_CLAUDE_COMMAND ?? "claude",
  buildClaudeCodeArgs
);
