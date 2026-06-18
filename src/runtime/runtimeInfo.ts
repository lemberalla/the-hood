export const runtimeCapabilities = [
  "structured_mcp_next_actions",
  "approval_artifact_next_actions",
  "isolated_patch_integration",
  "protected_integrated_patch_gate",
  "repo_context_external_approval",
  "chatgpt_web_bridge",
  "chatgpt_browser_manager",
  "cli_artifact_reads",
  "approval_phrase_enforcement",
  "final_report_artifacts",
  "mcp_final_report_next_action",
  "max_iteration_enforcement",
  "validation_command_capture",
  "branded_tui_shell",
  "approval_inbox_tui",
  "provider_access_modes",
  "mcp_repo_gateway_tools",
  "chatgpt_mcp_connector_mode"
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
