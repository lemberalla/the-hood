import type { AgentRequest } from "./types.js";
import type { JsonObject } from "../runtime/types.js";

const basePayloadSchema = (): JsonObject => ({
  type: "object",
  additionalProperties: true
});

const payloadSchemaForRole = (request: AgentRequest): JsonObject => {
  switch (request.role) {
    case "orchestrator":
    case "planner":
      return {
        ...basePayloadSchema(),
        required: ["action", "reason"],
        properties: {
          action: {
            type: "string",
            enum: ["delegate", "verify", "critique", "request_approval", "revise_plan", "complete", "abort"]
          },
          reason: {
            type: "string"
          }
        }
      };
    case "implementer":
      return {
        ...basePayloadSchema(),
        required: ["status"],
        properties: {
          status: {
            type: "string",
            enum: ["changed", "no_change", "blocked", "failed"]
          }
        }
      };
    case "verifier":
      return {
        ...basePayloadSchema(),
        required: ["verdict", "summary"],
        properties: {
          verdict: {
            type: "string",
            enum: ["approve", "revise", "abort", "ask_user"]
          },
          summary: {
            type: "string"
          }
        }
      };
    case "critic":
      return {
        ...basePayloadSchema(),
        required: ["verdict"],
        properties: {
          verdict: {
            type: "string",
            enum: ["acceptable", "needs_revision", "unsafe", "unclear"]
          }
        }
      };
    default:
      return basePayloadSchema();
  }
};

export const buildAgentResponseSchema = (request: AgentRequest): JsonObject => {
  const requiredDataKey = request.directive.outputContract.requiredDataKey;

  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "summary", "data"],
    properties: {
      status: {
        type: "string",
        enum: ["ok", "blocked", "failed"]
      },
      summary: {
        type: "string"
      },
      data: {
        type: "object",
        additionalProperties: false,
        required: [requiredDataKey],
        properties: {
          [requiredDataKey]: payloadSchemaForRole(request)
        }
      }
    }
  };
};
