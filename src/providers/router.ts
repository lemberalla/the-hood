import { ProviderUnavailableError } from "../runtime/errors.js";
import type { RoleAssignment } from "../runtime/types.js";
import { chatGptWebProvider } from "./chatgptWeb.js";
import { claudeCodeProvider } from "./claudeCode.js";
import { codexCliProvider } from "./codexCli.js";
import { stubProvider } from "./stub.js";
import type { ProviderAdapter } from "./types.js";

export const getProviderAdapter = (assignment: RoleAssignment): ProviderAdapter => {
  if (assignment.provider === stubProvider.id) {
    return stubProvider;
  }

  if (assignment.provider === chatGptWebProvider.id) {
    return chatGptWebProvider;
  }

  if (assignment.provider === codexCliProvider.id) {
    return codexCliProvider;
  }

  if (assignment.provider === claudeCodeProvider.id) {
    return claudeCodeProvider;
  }

  throw new ProviderUnavailableError(
    `Provider "${assignment.provider}" is not implemented yet. Use stub:<role>, chatgpt-web:chatgpt-pro, codex-cli:<model>, or claude-code:<model>.`
  );
};
