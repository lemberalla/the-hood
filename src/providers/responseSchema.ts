import type { AgentRequest } from "./types.js";
import { agentMarkdownField, agentMarkdownFieldDescription } from "./markdownPayload.js";
import type { JsonObject } from "../runtime/types.js";

const nullableStringSchema = (): JsonObject => ({
  type: ["string", "null"]
});

const nullableBooleanSchema = (): JsonObject => ({
  type: ["boolean", "null"]
});

const nullableStringArraySchema = (): JsonObject => ({
  type: ["array", "null"],
  items: {
    type: "string"
  }
});

const basePayloadSchema = (): JsonObject => ({
  type: "object",
  additionalProperties: false
});

const withDirectiveAckSchema = (request: AgentRequest, schema: JsonObject): JsonObject => {
  const required = Array.isArray(schema.required) ? schema.required.filter((value) => typeof value === "string") : [];
  const properties = schema.properties !== null && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties
    : {};

  const finalProperties = {
    ...properties,
    [agentMarkdownField]: {
      type: ["string", "null"],
      description: agentMarkdownFieldDescription
    },
    [request.directive.directiveAck.responseField]: {
      type: "object",
      additionalProperties: false,
      required: ["runId", "nonce", "responseField"],
      properties: {
        runId: {
          type: "string",
          enum: [request.directive.directiveAck.runId]
        },
        nonce: {
          type: "string",
          enum: [request.directive.directiveAck.nonce]
        },
        responseField: {
          type: "string",
          enum: [request.directive.directiveAck.responseField]
        }
      }
    }
  };

  return {
    ...schema,
    required: [...new Set([...required, ...Object.keys(finalProperties)])],
    properties: finalProperties
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
          },
          delegateTo: {
            type: ["string", "null"],
            enum: ["orchestrator", "planner", "implementer", "qa", "verifier", "critic", null]
          },
          nextRole: {
            type: ["string", "null"],
            enum: ["orchestrator", "planner", "implementer", "qa", "verifier", "critic", null]
          },
          requiresMoreEvidence: nullableBooleanSchema(),
          sliceName: nullableStringSchema(),
          targetPaths: nullableStringArraySchema(),
          requestedPaths: nullableStringArraySchema(),
          evidenceRefs: nullableStringArraySchema(),
          artifactRefs: nullableStringArraySchema(),
          callCritic: nullableBooleanSchema(),
          reasonCode: nullableStringSchema(),
          sourceRoles: nullableStringArraySchema(),
          acceptanceCriteria: nullableStringArraySchema()
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
          },
          changedFiles: nullableStringArraySchema(),
          commandsRun: nullableStringArraySchema(),
          unresolvedRisks: nullableStringArraySchema(),
          evidenceRefs: nullableStringArraySchema()
        }
      };
    case "qa":
      return {
        ...basePayloadSchema(),
        required: ["verdict", "summary"],
        properties: {
          verdict: {
            type: "string",
            enum: ["pass", "needs_revision", "needs_more_evidence", "blocked"]
          },
          summary: {
            type: "string"
          },
          suggestedCommands: nullableStringArraySchema(),
          risks: nullableStringArraySchema(),
          evidenceRefs: nullableStringArraySchema()
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
          },
          failedCriteria: nullableStringArraySchema(),
          risks: nullableStringArraySchema(),
          nextAction: nullableStringSchema(),
          evidenceRefs: nullableStringArraySchema()
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
          },
          blockingConcerns: nullableStringArraySchema(),
          nonBlockingConcerns: nullableStringArraySchema(),
          risks: nullableStringArraySchema(),
          evidenceRefs: nullableStringArraySchema()
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
