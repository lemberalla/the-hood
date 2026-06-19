import { PermissionDeniedError } from "./errors.js";
import { formatRoleAssignment } from "./role-assignment.js";
import type { RoleAssignment, RoleMap, RuntimeRole } from "./types.js";

export interface RolePermissionProfile {
  read: boolean;
  edit: boolean;
  shell: boolean;
  network: boolean;
}

export const defaultRolePermissions: Record<RuntimeRole, RolePermissionProfile> = {
  orchestrator: {
    read: true,
    edit: false,
    shell: false,
    network: true
  },
  planner: {
    read: true,
    edit: false,
    shell: false,
    network: true
  },
  researcher: {
    read: true,
    edit: false,
    shell: false,
    network: true
  },
  implementer: {
    read: true,
    edit: true,
    shell: true,
    network: false
  },
  qa: {
    read: true,
    edit: false,
    shell: false,
    network: false
  },
  verifier: {
    read: true,
    edit: false,
    shell: true,
    network: false
  },
  critic: {
    read: true,
    edit: false,
    shell: false,
    network: false
  },
  integrator: {
    read: true,
    edit: true,
    shell: true,
    network: false
  },
  citation: {
    read: true,
    edit: false,
    shell: false,
    network: true
  }
};

const sameAssignment = (left: RoleAssignment, right: RoleAssignment): boolean =>
  left.provider === right.provider && left.model === right.model;

export const assertRoleInvariants = (roles: RoleMap): void => {
  const implementer = roles.implementer;
  const verifier = roles.verifier;

  if (implementer && verifier && sameAssignment(implementer, verifier)) {
    throw new PermissionDeniedError(
      `Implementer and verifier cannot be the same agent (${formatRoleAssignment(implementer)}).`
    );
  }

  const verifierPermissions = defaultRolePermissions.verifier;
  const qaPermissions = defaultRolePermissions.qa;
  const criticPermissions = defaultRolePermissions.critic;

  if (verifierPermissions.edit || qaPermissions.edit || criticPermissions.edit) {
    throw new PermissionDeniedError("Verifier, QA, and critic roles must not have edit tools.");
  }
};
