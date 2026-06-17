import type { JsonObject, RoleAssignment, RunRecord, RuntimeRole } from "../runtime/types.js";
import type { RolePermissionProfile } from "../runtime/permissions.js";

export interface AgentOutputContract {
  schemaVersion: 1;
  name: string;
  requiredDataKey: string;
}

export interface AgentDirective {
  role: RuntimeRole;
  objective: string;
  instructions: string[];
  toolPermissions: RolePermissionProfile;
  outputContract: AgentOutputContract;
  variables: JsonObject;
}

export interface AgentRequest {
  run: RunRecord;
  role: RuntimeRole;
  assignment: RoleAssignment;
  context: JsonObject;
  directive: AgentDirective;
}
export interface AgentResponse {
  status: "ok" | "blocked" | "failed";
  summary: string;
  data: JsonObject;
}

export interface ProviderAdapter {
  id: string;
  runAgent(request: AgentRequest): Promise<AgentResponse>;
}
