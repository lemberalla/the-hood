import { InputError } from "../runtime/errors.js";
import { parseRole, parseRoleAssignment } from "../runtime/role-assignment.js";
import { runModes, type JsonObject, type JsonValue, type RoleMap, type RunMode } from "../runtime/types.js";

export const asObject = (value: JsonValue | undefined, name: string): JsonObject => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  throw new InputError(`${name} must be an object.`);
};

export const optionalObject = (value: JsonValue | undefined, name: string): JsonObject | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return asObject(value, name);
};

export const requiredString = (source: JsonObject, key: string): string => {
  const value = source[key];

  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  throw new InputError(`${key} must be a non-empty string.`);
};

export const optionalString = (source: JsonObject, key: string): string | undefined => {
  const value = source[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  throw new InputError(`${key} must be a non-empty string when provided.`);
};

export const optionalStringList = (source: JsonObject, key: string): string[] => {
  const value = source[key];

  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new InputError(`${key} must be an array of strings when provided.`);
  }

  return value as string[];
};

export const optionalRunMode = (source: JsonObject, key: string, fallback: RunMode): RunMode => {
  const value = source[key];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "string" && (runModes as readonly string[]).includes(value)) {
    return value as RunMode;
  }

  throw new InputError(`${key} must be one of: ${runModes.join(", ")}.`);
};

export const optionalRoleMapping = (source: JsonObject): RoleMap => {
  const raw = optionalObject(source.role_mapping, "role_mapping");
  const roles: RoleMap = {};

  if (!raw) {
    return roles;
  }

  for (const [role, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      throw new InputError(`role_mapping.${role} must use provider:model string format.`);
    }

    roles[parseRole(role)] = parseRoleAssignment(value);
  }

  return roles;
};
