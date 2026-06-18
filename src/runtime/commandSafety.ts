import path from "node:path";
import type { CommandSafetyCategory } from "./types.js";

export interface CommandSafety {
  category: CommandSafetyCategory;
  requiresApproval: boolean;
  reason?: string;
}

const commandName = (command: string): string => path.basename(command).toLowerCase();

const firstArg = (args: string[]): string => (args[0] ?? "").toLowerCase();

export const classifyCommand = (command: string, args: string[]): CommandSafety => {
  const name = commandName(command);
  const subcommand = firstArg(args);

  if (["rm", "rmdir", "unlink"].includes(name)) {
    return {
      category: "destructive",
      requiresApproval: true,
      reason: `${name} can delete files.`
    };
  }

  if (name === "git" && ["reset", "clean", "checkout", "switch", "merge", "rebase"].includes(subcommand)) {
    return {
      category: "destructive",
      requiresApproval: true,
      reason: `git ${subcommand} can rewrite or replace local state.`
    };
  }

  if (
    (name === "npm" && ["install", "i", "add"].includes(subcommand)) ||
    (["pnpm", "yarn"].includes(name) && ["install", "add"].includes(subcommand)) ||
    (name === "pip" && subcommand === "install") ||
    (name === "cargo" && subcommand === "add")
  ) {
    return {
      category: "dependency_install",
      requiresApproval: true,
      reason: `${name} ${subcommand} changes project dependencies.`
    };
  }

  if (["curl", "wget", "gh", "fly", "vercel", "wrangler"].includes(name)) {
    return {
      category: "network",
      requiresApproval: true,
      reason: `${name} can perform network operations.`
    };
  }

  if (name === "git" && ["status", "diff", "ls-files", "rev-parse", "show"].includes(subcommand)) {
    return {
      category: "read_only",
      requiresApproval: false
    };
  }

  if (name === "git" && subcommand === "apply") {
    return {
      category: "local_write",
      requiresApproval: false
    };
  }

  if (name === "npm" && subcommand === "run") {
    return {
      category: "local_write",
      requiresApproval: false
    };
  }

  return {
    category: "unknown",
    requiresApproval: false
  };
};
