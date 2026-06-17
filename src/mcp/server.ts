import readline from "node:readline";
import { mcpTools, findTool } from "./tools.js";
import {
  createError,
  createSuccess,
  mcpProtocolVersion,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse
} from "./protocol.js";
import { asObject, optionalObject, requiredString } from "./validation.js";
import type { JsonObject, JsonValue } from "../runtime/types.js";

const parseMessage = (line: string): JsonRpcRequest => {
  const parsed = JSON.parse(line) as unknown;

  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (parsed as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (parsed as { method?: unknown }).method === "string"
  ) {
    return parsed as JsonRpcRequest;
  }

  throw new Error("Invalid JSON-RPC request.");
};

const getRequestId = (request: JsonRpcRequest): JsonRpcId => request.id ?? null;

const sendResponse = (response: JsonRpcResponse): void => {
  process.stdout.write(`${JSON.stringify(response)}\n`);
};

const serverInfo = {
  name: "thehood",
  title: "TheHood",
  version: "0.0.0"
};

const initializeResult = (): JsonObject => ({
  protocolVersion: mcpProtocolVersion,
  capabilities: {
    tools: {
      listChanged: false
    }
  },
  serverInfo,
  instructions:
    "TheHood exposes a local agent runtime. The runtime owns state, permissions, approvals, and run records."
});

const listToolsResult = (): JsonObject => ({
  tools: mcpTools.map((tool) => tool.definition as unknown as JsonObject)
});

const callTool = async (params: JsonObject | undefined): Promise<JsonObject> => {
  const objectParams = asObject(params, "params");
  const name = requiredString(objectParams, "name");
  const tool = findTool(name);

  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const argumentsValue = objectParams.arguments as JsonValue | undefined;
  const result = await tool.handle(argumentsValue);

  return result as unknown as JsonObject;
};

const handleRequest = async (request: JsonRpcRequest): Promise<JsonValue | undefined> => {
  switch (request.method) {
    case "initialize":
      return initializeResult();
    case "ping":
      return {};
    case "tools/list":
      return listToolsResult();
    case "tools/call":
      return callTool(optionalObject(request.params, "params"));
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    default:
      throw new Error(`Method not found: ${request.method}`);
  }
};

export const startMcpServer = async (): Promise<void> => {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY
  });

  for await (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    let request: JsonRpcRequest;

    try {
      request = parseMessage(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendResponse(createError(null, -32700, message));
      continue;
    }

    const id = getRequestId(request);
    const isNotification = request.id === undefined;

    try {
      const result = await handleRequest(request);

      if (!isNotification && result !== undefined) {
        sendResponse(createSuccess(id, result));
      }
    } catch (error) {
      if (isNotification) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`thehood mcp notification error: ${message}\n`);
        continue;
      }

      const message = error instanceof Error ? error.message : String(error);
      const code = message.startsWith("Method not found") ? -32601 : -32603;
      sendResponse(createError(id, code, message));
    }
  }
};
