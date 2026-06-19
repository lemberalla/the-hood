import type { AgentRequest } from "./types.js";
import { agentMarkdownField, agentMarkdownFieldDescription } from "./markdownPayload.js";
import type { JsonObject } from "../runtime/types.js";

const basePayloadSchema = (): JsonObject => ({
  type: "object",
  additionalProperties: true
});

const withDirectiveAckSchema = (request: AgentRequest, schema: JsonObject): JsonObject => {
  const required = Array.isArray(schema.required) ? schema.required.filter((value) => typeof value === "string") : [];
  const properties = schema.properties !== null && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties
    : {};

  return {
    ...schema,
    required: [...new Set([...required, request.directive.directiveAck.responseField])],
    properties: {
      ...properties,
      [agentMarkdownField]: {
        type: "string",
        description: agentMarkdownFieldDescription
      },
      [request.directive.directiveAck.responseField]: {
        type: "object",
        additionalProperties: false,
        required: ["runId", "nonce", "responseField"],
        properties: {
          runId: {
            type: "string",
            const: request.directive.directiveAck.runId
          },
          nonce: {
            type: "string",
            const: request.directive.directiveAck.nonce
          },
          responseField: {
            type: "string",
            const: request.directive.directiveAck.responseField
          }
        }
      }
    }
  };
};

const payloadSchemaForRole = (request: AgentRequest): JsonObject => {
  const schema = (() => {
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
  })();

  return withDirectiveAckSchema(request, schema);
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
