import { InputError } from "./errors.js";
import { runtimeRoles, type RoleAssignment, type RuntimeRole } from "./types.js";

const roleSet = new Set<string>(runtimeRoles);

export const parseRole = (value: string): RuntimeRole => {
  if (roleSet.has(value)) {
    return value as RuntimeRole;
  }

  throw new InputError(
    `Unknown role "${value}". Expected one of: ${runtimeRoles.join(", ")}.`
  );
};

export const parseRoleAssignment = (value: string): RoleAssignment => {
  const separatorIndex = value.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new InputError(`Role assignment "${value}" must use provider:model format.`);
  }

  return {
    provider: value.slice(0, separatorIndex),
    model: value.slice(separatorIndex + 1)
  };
};

export const formatRoleAssignment = (assignment: RoleAssignment): string =>
  `${assignment.provider}:${assignment.model}`;

