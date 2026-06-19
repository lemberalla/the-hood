import { defaultRoles } from "./defaults.js";
import type { RoleMap, TheHoodConfig } from "./types.js";

export type TeamPresetId = "codex-default" | "pro-orchestrator" | "claude-critic";

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
