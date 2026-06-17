import { createLocalCommandProvider } from "./localCommand.js";
import type { AgentRequest } from "./types.js";

const sandboxForRequest = (request: AgentRequest): string =>
  request.directive.toolPermissions.edit ? "workspace-write" : "read-only";

export const buildCodexCliArgs = (request: AgentRequest): string[] => {
  const args = [
    "exec",
    "--cd",
    request.run.repoPath,
    "--sandbox",
    sandboxForRequest(request),
    "--ask-for-approval",
    "never",
    "--color",
    "never",
    "--skip-git-repo-check"
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
