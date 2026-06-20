import { defaultRoles } from "./defaults.js";
import type { RoleMap, TheHoodConfig } from "./types.js";

export type TeamPresetId =
  | "codex-default"
  | "pro-orchestrator"
  | "claude-critic"
  | "claude-second-judge"
  | "spark-plus-sonnet"
  | "claude-builder"
  | "pro-claude-high-assurance";

export interface TeamPreset {
  id: TeamPresetId;
  label: string;
  summary: string;
  roles: RoleMap;
  notes: string[];
}

const codexDefaultRoles = (): RoleMap => structuredClone(defaultRoles);

export const teamPresets: TeamPreset[] = [
  {
    id: "codex-default",
    label: "Codex Default",
    summary: "Codex owns orchestration and implementation; Codex Spark owns QA, verification, and critique.",
    roles: codexDefaultRoles(),
    notes: [
      "This is TheHood's product default.",
      "All mapped roles use local Codex CLI access and can be tuned one by one with role assignment."
    ]
  },
  {
    id: "pro-orchestrator",
    label: "ChatGPT Pro Orchestrator",
    summary: "ChatGPT Pro owns orchestration while Codex owns implementation, QA, verification, and critique.",
    roles: {
      ...codexDefaultRoles(),
      orchestrator: {
        provider: "chatgpt-web",
        model: "chatgpt-pro"
      }
    },
    notes: [
      "Best for Pro planning and strategy while keeping implementation and review local to Codex.",
      "ChatGPT Web still passes through runtime provider-invocation and transfer gates."
    ]
  },
  {
    id: "claude-critic",
    label: "Claude Critic",
    summary: "Codex owns the main loop while Claude Code acts as the critic lane.",
    roles: {
      ...codexDefaultRoles(),
      critic: {
        provider: "claude-code",
        model: "default"
      }
    },
    notes: [
      "Useful when the user wants an independent model family for critique.",
      "Claude Code availability is still checked by doctor and provider readiness."
    ]
  },
  {
    id: "claude-second-judge",
    label: "Claude Second Judge",
    summary: "Codex builds and verifies while Claude Code Sonnet challenges the work as critic.",
    roles: {
      ...codexDefaultRoles(),
      critic: {
        provider: "claude-code",
        model: "sonnet"
      }
    },
    notes: [
      "Best when the user wants Claude inside the Codex workflow as an independent second opinion.",
      "The critic lane stays advisory and read-only; verifier and runtime evidence remain authoritative."
    ]
  },
  {
    id: "spark-plus-sonnet",
    label: "Spark Plus Sonnet",
    summary: "Codex Spark handles implementation and QA while Claude Code Sonnet reviews and verifies.",
    roles: {
      ...codexDefaultRoles(),
      implementer: {
        provider: "codex-cli",
        model: "spark"
      },
      verifier: {
        provider: "claude-code",
        model: "sonnet"
      },
      critic: {
        provider: "claude-code",
        model: "sonnet"
      }
    },
    notes: [
      "Useful when Spark is the build lane and Sonnet is the independent review lane.",
      "The implementer and verifier remain different provider/model assignments."
    ]
  },
  {
    id: "claude-builder",
    label: "Claude Builder",
    summary: "Claude Code Sonnet implements while Codex Spark owns QA, verification, and critique.",
    roles: {
      ...codexDefaultRoles(),
      implementer: {
        provider: "claude-code",
        model: "sonnet"
      },
      qa: {
        provider: "codex-cli",
        model: "spark"
      },
      verifier: {
        provider: "codex-cli",
        model: "spark"
      },
      critic: {
        provider: "codex-cli",
        model: "spark"
      }
    },
    notes: [
      "Useful when the user prefers Claude for code edits but wants Codex to check the result.",
      "Claude edit output still goes through isolated patch, approval, validation, and verifier gates."
    ]
  },
  {
    id: "pro-claude-high-assurance",
    label: "Pro Claude High Assurance",
    summary: "ChatGPT Pro leads strategy, Codex implements, and Claude Code Sonnet verifies and critiques.",
    roles: {
      ...codexDefaultRoles(),
      orchestrator: {
        provider: "chatgpt-web",
        model: "chatgpt-pro"
      },
      verifier: {
        provider: "claude-code",
        model: "sonnet"
      },
      critic: {
        provider: "claude-code",
        model: "sonnet"
      }
    },
    notes: [
      "Best for public, reputational, architectural, or ambiguous work.",
      "Pro is strategic judgment, Claude is independent review, Codex is implementation, and runtime remains the authority."
    ]
  }
];

export const listTeamPresets = (): TeamPreset[] =>
  teamPresets.map((preset) => ({
    ...preset,
    roles: structuredClone(preset.roles),
    notes: [...preset.notes]
  }));

export const getTeamPreset = (id: string): TeamPreset | undefined =>
  listTeamPresets().find((preset) => preset.id === id);

export const teamPresetIds = (): string[] => teamPresets.map((preset) => preset.id);

export const applyTeamPreset = (
  config: TheHoodConfig,
  preset: TeamPreset
): TheHoodConfig => ({
  ...config,
  roles: {
    ...config.roles,
    ...preset.roles
  }
});
