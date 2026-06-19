import { defaultRoles } from "./defaults.js";
import { defaultRolePermissions } from "./permissions.js";
import { formatRoleAssignment } from "./role-assignment.js";
import { runtimeRoles, type RoleAssignment, type RuntimeRole, type TheHoodConfig } from "./types.js";
import type { RoleHealth, RuntimeHealthReport } from "./doctor.js";

export type RoleRosterState = "ready" | "needs_attention" | "unassigned";
export type RoleRosterAssignmentSource = "product_default" | "repo_config" | "unassigned";

export interface RoleRosterItem {
  role: RuntimeRole;
  laneLabel: string;
  responsibility: string;
  authority: string;
  assignment?: RoleAssignment;
  assignmentLabel: string;
  defaultAssignmentLabel?: string;
  assignmentSource: RoleRosterAssignmentSource;
  state: RoleRosterState;
  issues: string[];
  readOnly: boolean;
  permissions: {
    read: boolean;
    edit: boolean;
    shell: boolean;
    network: boolean;
  };
  providerEnabled?: boolean;
  providerImplemented?: boolean;
  modelConfigured?: boolean;
  commandFound?: boolean;
}

const roleMetadata: Record<RuntimeRole, Pick<RoleRosterItem, "laneLabel" | "responsibility" | "authority">> = {
  orchestrator: {
    laneLabel: "Agent 1 / Orchestrator",
    responsibility: "Plans, delegates, compares evidence, and decides the next loop step.",
    authority: "Strategy owner; no direct edit or final acceptance authority."
  },
  planner: {
    laneLabel: "Agent 1A / Planner",
    responsibility: "Creates implementation plans, risks, and acceptance criteria.",
    authority: "Read-only planning lane; advisory until runtime evidence exists."
  },
  researcher: {
    laneLabel: "Agent 1B / Researcher",
    responsibility: "Inspects repo, docs, logs, and bounded external references.",
    authority: "Read-only evidence lane; cannot change run state by itself."
  },
  implementer: {
    laneLabel: "Agent 2 / Implementer",
    responsibility: "Makes scoped code changes in an isolated worker path when possible.",
    authority: "Edit-capable worker; cannot apply its own patch or self-verify."
  },
  qa: {
    laneLabel: "Agent 3 / QA Tester",
    responsibility: "Finds missed cases and recommends deterministic validation.",
    authority: "Read-only advisory QA; cannot satisfy runtime validation gates."
  },
  verifier: {
    laneLabel: "Agent 4 / Verifier",
    responsibility: "Reviews runtime evidence against acceptance criteria.",
    authority: "Required independent review lane; cannot edit."
  },
  critic: {
    laneLabel: "Agent 5 / Critic",
    responsibility: "Challenges risks, missing cases, and design assumptions.",
    authority: "Read-only advisory review; cannot approve completion."
  },
  integrator: {
    laneLabel: "Runtime / Integrator",
    responsibility: "Applies approved patches and captures integration evidence.",
    authority: "Deterministic runtime lane; not a general model agent."
  },
  citation: {
    laneLabel: "Agent 6 / Citation",
    responsibility: "Checks evidence, attribution, and provenance.",
    authority: "Read-only citation lane; cannot satisfy verifier gates."
  }
};

const sameAssignment = (left: RoleAssignment | undefined, right: RoleAssignment | undefined): boolean =>
  Boolean(left && right && left.provider === right.provider && left.model === right.model);

const roleHealthByRole = (health: RuntimeHealthReport | undefined): Map<RuntimeRole, RoleHealth> =>
  new Map((health?.roles ?? []).map((roleHealth) => [roleHealth.role, roleHealth]));

const assignmentSource = (
  role: RuntimeRole,
  assignment: RoleAssignment | undefined
): RoleRosterAssignmentSource => {
  if (!assignment) {
    return "unassigned";
  }

  return sameAssignment(assignment, defaultRoles[role]) ? "product_default" : "repo_config";
};

const roleState = (
  assignment: RoleAssignment | undefined,
  issues: string[]
): RoleRosterState => {
  if (!assignment) {
    return "unassigned";
  }

  return issues.length > 0 ? "needs_attention" : "ready";
};

export const buildRoleRoster = (
  config: TheHoodConfig,
  health?: RuntimeHealthReport
): RoleRosterItem[] => {
  const healthByRole = roleHealthByRole(health);

  return runtimeRoles.map((role) => {
    const assignment = config.roles[role];
    const defaultAssignment = defaultRoles[role];
    const roleHealth = healthByRole.get(role);
    const issues = roleHealth?.issues ?? [];
    const permissions = defaultRolePermissions[role];

    return {
      role,
      ...roleMetadata[role],
      ...(assignment ? { assignment } : {}),
      assignmentLabel: assignment ? formatRoleAssignment(assignment) : "unassigned",
      ...(defaultAssignment ? { defaultAssignmentLabel: formatRoleAssignment(defaultAssignment) } : {}),
      assignmentSource: assignmentSource(role, assignment),
      state: roleState(assignment, issues),
      issues,
      readOnly: !permissions.edit,
      permissions: { ...permissions },
      ...(roleHealth
        ? {
            providerEnabled: roleHealth.providerEnabled,
            providerImplemented: roleHealth.providerImplemented,
            modelConfigured: roleHealth.modelConfigured,
            ...(roleHealth.commandFound === undefined ? {} : { commandFound: roleHealth.commandFound })
          }
        : {})
    };
  });
};
