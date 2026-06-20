import { createLocalCommandProvider } from "./localCommand.js";
import { codexCliCommand, resolveCodexCliModel } from "./codexCliModels.js";
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
    "--color",
    "never",
    "--skip-git-repo-check",
    "--output-schema",
    context.schemaPath
  ];

  if (request.assignment.model !== "default") {
    args.push("--model", resolveCodexCliModel(request.assignment.model));
  }

  args.push("-");
  return args;
};

export const codexCliProvider = createLocalCommandProvider(
  "codex-cli",
  codexCliCommand(),
  buildCodexCliArgs
);

export { resolveCodexCliModel };
