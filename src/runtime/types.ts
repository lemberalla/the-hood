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
  "qa",
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
  fanoutMaxItems: number;
  editRequiresApproval: boolean;
  dependencyInstallRequiresApproval: boolean;
  networkRequiresApproval: boolean;
  protectedTestPaths: string[];
}

export type ApprovalPolicyMode = "manual" | "auto_low_risk" | "autopilot";
export type ExternalTransferApprovalMode = "manual" | "auto_low_risk";
export type ExternalTransferPolicyDecision = "manual" | "auto_approve";

export interface ExternalTransferPolicyRule {
  provider?: string;
  model?: string;
  purposes?: ExternalTransferPurpose[];
  riskClasses?: ExternalTransferRiskClass[];
  maxBytes?: number;
  decision: ExternalTransferPolicyDecision;
}

export interface ExternalTransferApprovalPolicy {
  mode: ExternalTransferApprovalMode;
  maxAutoApproveBytes: number;
  rules: ExternalTransferPolicyRule[];
}

export interface ApprovalPolicy {
  mode: ApprovalPolicyMode;
  externalTransfers: ExternalTransferApprovalPolicy;
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
  approvalPolicy: ApprovalPolicy;
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
  | "remote_context"
  | "progress"
  | "reconciliation"
  | "critic_trigger"
  | "revision_packet"
  | "review_routing"
  | "fanout"
  | "provider_invocation"
  | "transfer_manifest";

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

export type RunHandoffKind = "agent_handoff" | "approval_gate" | "approval_auto_approved" | "completion";

export interface RunHandoffEvent {
  id: string;
  createdAt: string;
  kind: RunHandoffKind;
  reason: string;
  stateBefore: RunState;
  stateAfter: RunState;
  fromRole?: RuntimeRole;
  fromProvider?: string;
  fromModel?: string;
  toRole?: RuntimeRole;
  toProvider?: string;
  toModel?: string;
  gate?: string;
  approvalEventId?: string;
  artifactRefs?: string[];
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
  handoffs: RunHandoffEvent[];
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

export type ReviewLaneKind = "reviewer" | "tester" | "qa" | "critic";
export type ReviewLaneState = "pending" | "satisfied" | "needs_revision" | "blocked" | "failed";
export type ReviewLaneSourceKind =
  | "required_gate"
  | "verifier_response"
  | "qa_response"
  | "critic_response"
  | "validation_evidence"
  | "summon_evidence";

export type ReviewLaneOwnerKind = "role" | "runtime";

export interface ReviewLaneOwner {
  kind: ReviewLaneOwnerKind;
  label: string;
  readOnly: boolean;
  role?: RuntimeRole;
  provider?: string;
  model?: string;
  assignment?: string;
}

export interface ReviewLaneEvidence {
  sourceKind: ReviewLaneSourceKind;
  summary: string;
  sourceRefs: ProgressPacketSourceRef[];
  artifactRefs: string[];
  eventRefs: string[];
  canSatisfyRequired: boolean;
}

export interface ReviewLane {
  id: string;
  label: string;
  kind: ReviewLaneKind;
  state: ReviewLaneState;
  required: boolean;
  sourceKind: ReviewLaneSourceKind;
  summary: string;
  sourceRefs: ProgressPacketSourceRef[];
  artifactRefs: string[];
  eventRefs: string[];
  owner: ReviewLaneOwner;
  canSatisfyRequired: boolean;
  satisfiesRequired: boolean;
  sidecarEvidence: ReviewLaneEvidence[];
  role?: RuntimeRole;
}

export type OperatorNextActionKind =
  | "review_approval_reason"
  | "inspect_artifact"
  | "inspect_final_report"
  | "inspect_progress_packet"
  | "preview_external_transfer"
  | "continue_with_approval"
  | "reject_or_revise"
  | "continue"
  | "inspect_status"
  | "inspect_artifacts"
  | "reconcile"
  | "wait_for_provider"
  | "review_required"
  | "validation_required"
  | "terminal_complete"
  | "terminal_failed"
  | "terminal_aborted";

export type OperatorNextActionOwnerKind = "runtime" | "role";

export interface OperatorNextActionOwner {
  kind: OperatorNextActionOwnerKind;
  label: string;
  role?: RuntimeRole;
}

export interface OperatorNextActionArtifact {
  kind: RunArtifactKind;
  ref: string;
  summary: string;
}

export interface OperatorNextAction {
  action: OperatorNextActionKind;
  label: string;
  description: string;
  owner: OperatorNextActionOwner;
  blocking: boolean;
  required: boolean;
  state: string;
  reason: string;
  generatedAt: string;
  artifactRefs: string[];
  eventRefs: string[];
  commandHint?: string;
  mcpToolHint?: string;
  tool?: string;
  arguments?: JsonObject;
  artifact?: OperatorNextActionArtifact;
}

export type LoopResponsibilityKind =
  | "plan"
  | "implement"
  | "test"
  | "verify"
  | "qa"
  | "critique"
  | "reconcile"
  | "integrate"
  | "operator_approval"
  | "complete";

export type LoopResponsibilityStatus =
  | "pending"
  | "ready"
  | "in_progress"
  | "satisfied"
  | "blocked"
  | "skipped"
  | "advisory";

export type LoopResponsibilityOwnerKind = "runtime" | "role";

export interface LoopResponsibilityOwner {
  kind: LoopResponsibilityOwnerKind;
  label: string;
  role?: RuntimeRole;
  provider?: string;
  model?: string;
  assignment?: string;
  readOnly?: boolean;
}

export interface LoopResponsibility {
  id: string;
  kind: LoopResponsibilityKind;
  label: string;
  owner: LoopResponsibilityOwner;
  required: boolean;
  blocking: boolean;
  status: LoopResponsibilityStatus;
  state: RunState;
  reason: string;
  canSatisfyGate: boolean;
  artifactRefs: string[];
  eventRefs: string[];
  handoffRefs: string[];
  sidecarOnly?: boolean;
}

export interface LoopResponsibilitySchedule {
  schemaVersion: 1;
  kind: "loop_responsibility_schedule";
  runId: string;
  generatedAt: string;
  phase: RunState;
  responsibilities: LoopResponsibility[];
  blockers: LoopResponsibility[];
}

export interface ProgressPacketLimits {
  maxArtifacts: number;
  maxProviderResponses: number;
  maxApprovalEvents: number;
  maxToolEvents: number;
  maxRunEvents: number;
  maxOpenQuestions: number;
  maxReviewLanes: number;
  maxOperatorNextActions: number;
  maxLoopResponsibilities: number;
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
  providerExecution?: ProgressPacketArtifactRef;
  verifierResponse?: ProgressPacketProviderResponse;
  criticTrigger?: ProgressPacketArtifactRef;
  revisionPacket?: ProgressPacketArtifactRef;
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
  reviewLanes: ProgressPacketBoundedSection<ReviewLane>;
  operatorNextActions: ProgressPacketBoundedSection<OperatorNextAction>;
  loopResponsibilities: ProgressPacketBoundedSection<LoopResponsibility>;
  evidence: ProgressPacketEvidence;
  openQuestions: ProgressPacketBoundedSection<ProgressPacketOpenQuestion>;
  provenance: ProgressPacketProvenance;
  bounds: ProgressPacketBounds;
}

export type ExternalTransferPurpose =
  | "repo_context"
  | "progress_packet"
  | "memory_packet"
  | "reconciliation";

export type ExternalTransferRiskClass =
  | "public"
  | "repo_context"
  | "private_runtime_memory"
  | "secret_risk";

export interface ExternalTransferArtifactRef {
  kind: RunArtifactKind;
  ref: string;
  summary: string;
  byteLength: number;
  truncated: boolean;
  sha256: string;
}

export interface ExternalTransferRisk {
  class: ExternalTransferRiskClass;
  reasons: string[];
  secretPatternHits: number;
}

export interface ExternalTransferManifest {
  schemaVersion: 1;
  kind: "external_transfer_manifest";
  runId: string;
  createdAt: string;
  destination: RoleAssignment;
  role: RuntimeRole;
  purpose: ExternalTransferPurpose;
  approvalPhrase: string;
  approvalHint: string;
  artifacts: ExternalTransferArtifactRef[];
  totalBytes: number;
  risk: ExternalTransferRisk;
  redaction: {
    status: "not_applied" | "applied";
    notes: string[];
  };
  preview: {
    maxBytes: number;
    content: string;
    truncated: boolean;
  };
  provenance: {
    sourceArtifactRefs: string[];
    notes: string[];
  };
}
