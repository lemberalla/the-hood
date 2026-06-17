import { createLocalCommandProvider } from "./localCommand.js";
import type { AgentRequest } from "./types.js";

const permissionModeForRequest = (request: AgentRequest): string =>
  request.directive.toolPermissions.edit ? "default" : "plan";

const toolsForRequest = (request: AgentRequest): string => {
  if (request.directive.toolPermissions.edit) {
    return "Read,Glob,Grep,Edit,MultiEdit,Write,Bash";
  }

  if (request.directive.toolPermissions.shell) {
    return "Read,Glob,Grep,Bash";
  }

  return "Read,Glob,Grep";
};

export const buildClaudeCodeArgs = (request: AgentRequest): string[] => {
  const args = [
    "--print",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--permission-mode",
    permissionModeForRequest(request),
    "--tools",
    toolsForRequest(request)
  ];

  if (request.assignment.model !== "default") {
    args.push("--model", request.assignment.model);
  }

  return args;
};

export const claudeCodeProvider = createLocalCommandProvider(
  "claude-code",
  process.env.THEHOOD_CLAUDE_COMMAND ?? "claude",
  buildClaudeCodeArgs
);
