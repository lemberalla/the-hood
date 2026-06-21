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
    "TheHood exposes a local agent runtime. The runtime owns state, permissions, approvals, and run records. Use thehood_doctor before invoking model-backed agents. Users can assign GPT, Claude, Codex, API, or local models to runtime roles with provider:model strings. Use thehood_model_access before external model-backed consults, fan-outs, or orchestrations that may disclose repo context, progress packets, or memory to Claude, Codex, ChatGPT, API, or local model providers; it is local-only and returns repo visibility, a compact approval packet, and fallback paths. If the repo is dirty or unpushed, show the returned choices: commit and push a checkpoint, approve bounded local context or diff transfer, use no-repo-context strategy, or cancel. If the repo is clean and pushed, use the remote GitHub refs default only when the preflight reports the provider route as confirmed; for chatgpt-web, unconfirmed bridge GitHub connector access still requires user choice. Use thehood_pro_access before direct ChatGPT Pro consults from Codex, or after host policy rejects a chatgpt-web call, because TheHood autopilot cannot override Codex or tenant external-disclosure policy. If host policy rejects a model-backed call, do not ask the user to type a fresh long disclosure phrase; present the model-access packet copyable_text_block in a fenced text block, or switch to no-repo-context or connector mode. For ChatGPT Developer Mode connector onboarding, generate TheHood tunnel guidance with thehood mcp tunnel --tunnel-id <id> --profile thehood-local, keep Secure MCP Tunnel running, and validate from a new ChatGPT conversation with thehood_doctor plus read-only repo gateway tools. Use thehood_consult to bring in a read-only guest agent such as Claude as a second judge, critic, QA tester, planner, or reviewer, and use thehood_orchestrate for implementation runs. Use thehood_continue with approval=none when no manual approval gate is active; if autopilot applies, the runtime may auto-approve bounded gates such as provider invocation and non-secret external transfers and will record approval_auto_approved evidence. Use approval=approve/reject/revise only for an active manual approval gate after the user authorizes that gate."
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
