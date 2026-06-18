import { TheHoodError } from "../runtime/errors.js";
import type { JsonObject, JsonValue } from "../runtime/types.js";

export const mcpProtocolVersion = "2025-06-18";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: JsonObject;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: JsonValue;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: JsonValue;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  structuredContent?: JsonObject;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  annotations?: JsonObject;
}

export const createSuccess = (id: JsonRpcId, result: JsonValue): JsonRpcSuccessResponse => ({
  jsonrpc: "2.0",
  id,
  result
});

export const createError = (
  id: JsonRpcId,
  code: number,
  message: string,
  data?: JsonValue
): JsonRpcErrorResponse => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data }
});

export const toolResult = (structuredContent: JsonObject, isError = false): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(structuredContent, null, 2)
    }
  ],
  structuredContent,
  isError
});

export const errorToolResult = (error: unknown): ToolResult => {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof TheHoodError ? error.code : "tool_error";

  return toolResult(
    {
      error: {
        code,
        message
      }
    },
    true
  );
};
