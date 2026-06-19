import { SchemaValidationError } from "./errors.js";
import type { AgentDirective, AgentResponse } from "../providers/types.js";
import type { JsonObject, JsonValue, RuntimeRole } from "./types.js";

const responseStatuses = new Set(["ok", "blocked", "failed"]);
const orchestratorActions = new Set([
  "delegate",
  "verify",
  "critique",
  "request_approval",
  "revise_plan",
  "complete",
  "abort"
]);
const implementationStatuses = new Set(["changed", "no_change", "blocked", "failed"]);
const qaVerdicts = new Set(["pass", "needs_revision", "needs_more_evidence", "blocked"]);
const verificationVerdicts = new Set(["approve", "revise", "abort", "ask_user"]);
const critiqueVerdicts = new Set(["acceptable", "needs_revision", "unsafe", "unclear"]);

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requireStringField = (value: JsonObject, field: string, contract: string): string => {
  const candidate = value[field];

  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new SchemaValidationError(`${contract}.${field} must be a non-empty string.`);
  }

  return candidate;
};

const requireAllowedValue = (value: JsonObject, field: string, allowed: Set<string>, contract: string): void => {
  const candidate = requireStringField(value, field, contract);

  if (!allowed.has(candidate)) {
    throw new SchemaValidationError(`${contract}.${field} has unsupported value "${candidate}".`);
  }
};

const validateRolePayload = (role: RuntimeRole, payload: JsonObject, contractName: string): void => {
  switch (role) {
    case "orchestrator":
    case "planner":
      requireAllowedValue(payload, "action", orchestratorActions, contractName);
      requireStringField(payload, "reason", contractName);
      return;
    case "implementer":
      requireAllowedValue(payload, "status", implementationStatuses, contractName);
      return;
    case "qa":
      requireAllowedValue(payload, "verdict", qaVerdicts, contractName);
      requireStringField(payload, "summary", contractName);
      return;
    case "verifier":
      requireAllowedValue(payload, "verdict", verificationVerdicts, contractName);
      requireStringField(payload, "summary", contractName);
      return;
    case "critic":
      requireAllowedValue(payload, "verdict", critiqueVerdicts, contractName);
      return;
    default:
      return;
  }
};

const validateDirectiveAck = (
  directive: AgentDirective,
  payload: JsonObject,
  contractName: string
): void => {
  const { responseField, runId, nonce } = directive.directiveAck;
  const ack = payload[responseField];

  if (ack === undefined) {
    return;
  }

  if (!isObject(ack)) {
    throw new SchemaValidationError(`${contractName}.${responseField} must be an object when present.`);
  }

  if (ack.runId !== runId || ack.nonce !== nonce) {
    throw new SchemaValidationError(`${contractName}.${responseField} does not match the current directive.`);
  }
};

export const validateAgentResponse = (
  role: RuntimeRole,
  directive: AgentDirective,
  response: AgentResponse
): void => {
  if (!responseStatuses.has(response.status)) {
    throw new SchemaValidationError(`Agent response status "${response.status}" is not supported.`);
  }

  if (typeof response.summary !== "string" || response.summary.trim().length === 0) {
    throw new SchemaValidationError("Agent response summary must be a non-empty string.");
  }

  if (!isObject(response.data)) {
    throw new SchemaValidationError("Agent response data must be an object.");
  }

  const { requiredDataKey, name } = directive.outputContract;
  const payload = response.data[requiredDataKey];

  if (!isObject(payload)) {
    throw new SchemaValidationError(`${name} response must include object data.${requiredDataKey}.`);
  }

  validateRolePayload(role, payload, name);
  validateDirectiveAck(directive, payload, name);
};
