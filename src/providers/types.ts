import type { JsonObject, RoleAssignment, RunRecord, RuntimeRole } from "../runtime/types.js";

export interface AgentRequest {
  run: RunRecord;
  role: RuntimeRole;
  assignment: RoleAssignment;
  context: JsonObject;
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
