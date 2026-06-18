import path from "node:path";

export interface McpLaunchConfig {
  command: string;
  args: string[];
  startupTimeoutSec?: number;
  env?: Record<string, string>;
}

export interface McpConfigReport {
  installed: McpLaunchConfig;
  local: McpLaunchConfig;
  installedToml: string;
  localToml: string;
}

export interface McpConfigOptions {
  includeChatGptWeb?: boolean;
  cdpUrl?: string;
}

const quoteTomlString = (value: string): string =>
  JSON.stringify(value);

const formatToml = (config: McpLaunchConfig): string => [
  "[mcp_servers.thehood]",
  `command = ${quoteTomlString(config.command)}`,
  `args = [${config.args.map(quoteTomlString).join(", ")}]`,
  ...(config.startupTimeoutSec === undefined ? [] : [`startup_timeout_sec = ${config.startupTimeoutSec}`]),
  ...(config.env
    ? [
        `env = { ${Object.entries(config.env)
          .map(([key, value]) => `${key} = ${quoteTomlString(value)}`)
          .join(", ")} }`
      ]
    : [])
].join("\n");

const chatGptEnv = (command: string, cdpUrl: string): Record<string, string> => ({
  THEHOOD_CHATGPT_WEB_COMMAND: command,
  THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED: "1",
  THEHOOD_CHATGPT_WEB_CDP_URL: cdpUrl,
  THEHOOD_CHATGPT_WEB_TIMEOUT_MS: "300000"
});

const localBridgePath = (cliPath: string | undefined): string =>
  path.resolve(path.dirname(path.resolve(cliPath ?? "dist/cli/main.js")), "..", "bridges", "chatgptWebBridge.js");

export const getMcpConfigReport = (
  cliPath: string | undefined,
  options: McpConfigOptions = {}
): McpConfigReport => {
  const cdpUrl = options.cdpUrl ?? "http://127.0.0.1:9222";
  const installed: McpLaunchConfig = {
    command: "thehood",
    args: ["mcp"],
    startupTimeoutSec: 120,
    ...(options.includeChatGptWeb
      ? {
          env: chatGptEnv("thehood-chatgpt-web-bridge", cdpUrl)
        }
      : {})
  };
  const local: McpLaunchConfig = {
    command: process.execPath,
    args: [path.resolve(cliPath ?? "dist/cli/main.js"), "mcp"],
    startupTimeoutSec: 120,
    ...(options.includeChatGptWeb
      ? {
          env: chatGptEnv(localBridgePath(cliPath), cdpUrl)
        }
      : {})
  };

  return {
    installed,
    local,
    installedToml: formatToml(installed),
    localToml: formatToml(local)
  };
};
