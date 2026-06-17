export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const runModes = ["plan", "research", "implement", "review"] as const;
export type RunMode = (typeof runModes)[number];

export const runStates = [
  "created",
  "planning",
  "awaiting_approval",
  "delegating",
  "implementing",
  "verifying",
  "critiquing",
  "integrating",
  "completed",
  "failed",
  "aborted"
] as const;
export type RunState = (typeof runStates)[number];

export const runtimeRoles = [
  "orchestrator",
  "planner",
  "researcher",
  "implementer",
  "verifier",
  "critic",
  "integrator",
  "citation"
] as const;
export type RuntimeRole = (typeof runtimeRoles)[number];

export const approvalDecisions = ["approve", "reject", "revise"] as const;
export type ApprovalDecision = (typeof approvalDecisions)[number];

export interface RoleAssignment {
  provider: string;
  model: string;
}

export type RoleMap = Partial<Record<RuntimeRole, RoleAssignment>>;

export interface RuntimeDefaults {
  maxIterations: number;
  editRequiresApproval: boolean;
  dependencyInstallRequiresApproval: boolean;
  networkRequiresApproval: boolean;
  protectedTestPaths: string[];
}

export interface ProviderConfig {
  enabled: boolean;
  models: string[];
  apiKeyEnv?: string;
  browserProfile?: string;
}

export interface TheHoodConfig {
  version: 1;
  defaults: RuntimeDefaults;
  providers: Record<string, ProviderConfig>;
  roles: RoleMap;
}

export interface RunArtifact {
  kind: "plan" | "diff" | "log" | "report" | "metadata";
  ref: string;
  summary: string;
}

export interface ApprovalEvent {
  id: string;
  createdAt: string;
  decision: ApprovalDecision;
  reason: string;
}

export interface ToolEvent {
  id: string;
  createdAt: string;
  tool: string;
  cwd: string;
  exitCode: number;
  durationMs: number;
  stdoutRef?: string;
  stderrRef?: string;
}

export interface RunEvent {
  id: string;
  createdAt: string;
  type: string;
  message: string;
  data?: JsonObject;
}

export interface RunRecord {
  runId: string;
  createdAt: string;
  updatedAt: string;
  repoPath: string;
  userGoal: string;
  mode: RunMode;
  state: RunState;
  roleMapping: RoleMap;
  constraints: string[];
  maxIterations: number;
  approvalRequired: boolean;
  approvalReason?: string;
  stopReason?: string;
  artifacts: RunArtifact[];
  approvalEvents: ApprovalEvent[];
  toolEvents: ToolEvent[];
  events: RunEvent[];
}

