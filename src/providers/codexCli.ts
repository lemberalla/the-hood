import { createLocalCommandProvider } from "./localCommand.js";
import type { LocalAgentCommandContext } from "./localCommand.js";
import type { AgentRequest } from "./types.js";

const sandboxForRequest = (request: AgentRequest): string =>
  request.directive.toolPermissions.edit ? "workspace-write" : "read-only";

export const buildCodexCliArgs = (request: AgentRequest, context: LocalAgentCommandContext): string[] => {
  const args = [
    "exec",
    "--cd",
    context.workspacePath,
    "--sandbox",
    sandboxForRequest(request),
    "--ask-for-approval",
    "never",
    "--color",
    "never",
    "--skip-git-repo-check",
    "--output-schema",
    context.schemaPath
  ];

  if (request.assignment.model !== "default") {
    args.push("--model", request.assignment.model);
  }

  args.push("-");
  return args;
};

export const codexCliProvider = createLocalCommandProvider(
  "codex-cli",
  process.env.THEHOOD_CODEX_COMMAND ?? "codex",
  buildCodexCliArgs
);
