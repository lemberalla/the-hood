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

export const providerAccessModes = ["agent-bridge", "api-agent", "mcp-connector"] as const;
export type ProviderAccessMode = (typeof providerAccessModes)[number];

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
  accessModes?: ProviderAccessMode[];
  defaultAccessMode?: ProviderAccessMode;
  apiKeyEnv?: string;
  browserProfile?: string;
}

export interface TheHoodConfig {
  version: 1;
  defaults: RuntimeDefaults;
  providers: Record<string, ProviderConfig>;
  roles: RoleMap;
}

export type RunArtifactKind =
  | "plan"
  | "diff"
  | "log"
  | "report"
  | "metadata"
  | "status"
  | "agent"
  | "directive"
  | "context"
  | "progress";

export interface RunArtifact {
  kind: RunArtifactKind;
  ref: string;
  summary: string;
}

export type CommandSafetyCategory =
  | "read_only"
  | "local_write"
  | "dependency_install"
  | "network"
  | "destructive"
  | "credential_sensitive"
  | "unknown";

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
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  durationMs: number;
  safetyCategory: CommandSafetyCategory;
  permissionDecision: "allowed" | "allowed_explicit_user" | "denied";
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
  preferredRole?: RuntimeRole;
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

export type ProgressPacketSourceKind =
  | "run_record"
  | "run_artifact"
  | "run_event"
  | "approval_event"
  | "tool_event";

export interface ProgressPacketSourceRef {
  kind: ProgressPacketSourceKind;
  runId: string;
  id?: string;
  ref?: string;
  eventType?: string;
}

export interface ProgressPacketLimits {
  maxArtifacts: number;
  maxProviderResponses: number;
  maxApprovalEvents: number;
  maxToolEvents: number;
  maxRunEvents: number;
  maxOpenQuestions: number;
  maxStringLength: number;
}

export interface ProgressPacketSectionBounds {
  included: number;
  omitted: number;
  truncated: boolean;
}

export interface ProgressPacketBounds {
  limits: ProgressPacketLimits;
  sections: Record<string, ProgressPacketSectionBounds>;
  truncated: boolean;
  textFieldsTruncated: number;
}

export interface ProgressPacketBoundedSection<T> {
  items: T[];
  omitted: number;
  truncated: boolean;
}

export interface ProgressPacketArtifactRef {
  kind: RunArtifactKind;
  ref: string;
  summary: string;
  canonical: true;
  source: ProgressPacketSourceRef;
}

export interface ProgressPacketApproval {
  id: string;
  createdAt: string;
  decision: ApprovalDecision;
  reason: string;
  source: ProgressPacketSourceRef;
}

export interface ProgressPacketToolEvidence {
  id: string;
  createdAt: string;
  tool: string;
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  durationMs: number;
  safetyCategory: CommandSafetyCategory;
  permissionDecision: ToolEvent["permissionDecision"];
  stdoutRef?: string;
  stderrRef?: string;
  source: ProgressPacketSourceRef;
}

export interface ProgressPacketRunEvent {
  id: string;
  createdAt: string;
  type: string;
  message: string;
  data?: JsonObject;
  source: ProgressPacketSourceRef;
}

export interface ProgressPacketProviderResponse {
  role?: RuntimeRole;
  provider?: string;
  model?: string;
  status?: string;
  summary: string;
  artifact?: ProgressPacketArtifactRef;
  event?: ProgressPacketRunEvent;
  sourceRefs: ProgressPacketSourceRef[];
}

export interface ProgressPacketEvidenceGroup {
  artifacts: ProgressPacketBoundedSection<ProgressPacketArtifactRef>;
  events: ProgressPacketBoundedSection<ProgressPacketRunEvent>;
  toolEvents: ProgressPacketBoundedSection<ProgressPacketToolEvidence>;
}

export interface ProgressPacketOpenQuestion {
  severity: "info" | "risk" | "blocking";
  question: string;
  sourceRefs: ProgressPacketSourceRef[];
}

export interface ProgressPacketRunSnapshot {
  runId: string;
  repoPath: string;
  userGoal: string;
  mode: RunMode;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  approvalRequired: boolean;
  approvalReason?: string;
  stopReason?: string;
  maxIterations: number;
  artifactCount: number;
  approvalEventCount: number;
  toolEventCount: number;
  runEventCount: number;
  providerResponseCount: number;
  source: ProgressPacketSourceRef;
}

export interface ProgressPacketLatestState {
  plan?: ProgressPacketArtifactRef;
  providerResponse?: ProgressPacketProviderResponse;
  verifierResponse?: ProgressPacketProviderResponse;
  finalReport?: ProgressPacketArtifactRef;
  repoContext?: ProgressPacketArtifactRef;
}

export interface ProgressPacketEvidence {
  artifacts: ProgressPacketBoundedSection<ProgressPacketArtifactRef>;
  providerResponses: ProgressPacketBoundedSection<ProgressPacketProviderResponse>;
  approvals: ProgressPacketBoundedSection<ProgressPacketApproval>;
  toolEvents: ProgressPacketBoundedSection<ProgressPacketToolEvidence>;
  runEvents: ProgressPacketBoundedSection<ProgressPacketRunEvent>;
  git: ProgressPacketEvidenceGroup;
  validation: ProgressPacketEvidenceGroup;
  verifierVerdicts: ProgressPacketBoundedSection<ProgressPacketProviderResponse>;
}

export interface ProgressPacketProvenance {
  canonicalSources: ProgressPacketSourceRef[];
  derivedFields: string[];
  notes: string[];
}

export interface ProgressPacket {
  schemaVersion: 1;
  kind: "progress_packet";
  ontologyVersion: "initial";
  ontologyTerms: string[];
  run: ProgressPacketRunSnapshot;
  roleMapping: RoleMap;
  latest: ProgressPacketLatestState;
  evidence: ProgressPacketEvidence;
  openQuestions: ProgressPacketBoundedSection<ProgressPacketOpenQuestion>;
  provenance: ProgressPacketProvenance;
  bounds: ProgressPacketBounds;
}
