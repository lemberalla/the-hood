export const runtimeCapabilities = [
  "structured_mcp_next_actions",
  "approval_artifact_next_actions",
  "isolated_patch_integration",
  "protected_integrated_patch_gate",
  "repo_context_external_approval",
  "chatgpt_web_bridge",
  "cli_artifact_reads",
  "approval_phrase_enforcement",
  "final_report_artifacts"
] as const;

export type RuntimeCapability = (typeof runtimeCapabilities)[number];

export interface RuntimeInfo {
  name: "thehood";
  version: string;
  capabilities: RuntimeCapability[];
}

export const runtimeInfo: RuntimeInfo = {
  name: "thehood",
  version: "0.0.0",
  capabilities: [...runtimeCapabilities]
};
