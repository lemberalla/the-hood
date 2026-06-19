export const runtimeCapabilities = [
  "structured_mcp_next_actions",
  "approval_artifact_next_actions",
  "isolated_patch_integration",
  "protected_integrated_patch_gate",
  "repo_context_external_approval",
  "chatgpt_web_bridge",
  "chatgpt_web_bridge_fail_fast",
  "chatgpt_browser_manager",
  "cli_artifact_reads",
  "approval_phrase_enforcement",
  "final_report_artifacts",
  "progress_packet_artifacts",
  "external_transfer_manifests",
  "external_transfer_approval_policy",
  "targeted_repo_context_followups",
  "planner_reconciliation",
  "canonical_memory_rehydration",
  "mcp_final_report_next_action",
  "max_iteration_enforcement",
  "validation_command_capture",
  "branded_tui_shell",
  "approval_inbox_tui",
  "operator_run_monitor",
  "operator_next_actions",
  "autopilot_approval_policy",
  "run_status_insights",
  "same_run_agent_summons",
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
