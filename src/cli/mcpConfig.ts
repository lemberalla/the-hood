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

export interface McpTunnelLaunchConfig {
  profile: string;
  tunnelId: string;
  mcpCommand: string;
  initCommand: string;
  doctorCommand: string;
  runCommand: string;
}

export interface McpTunnelConfigReport {
  installed: McpTunnelLaunchConfig;
  local: McpTunnelLaunchConfig;
  chatGptSteps: string[];
  notes: string[];
}

export interface McpConfigOptions {
  includeChatGptWeb?: boolean;
  cdpUrl?: string;
}

export interface McpTunnelConfigOptions {
  profile?: string;
  tunnelId?: string;
}

const quoteTomlString = (value: string): string =>
  JSON.stringify(value);

const shellQuote = (value: string): string => {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
};

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
  THEHOOD_CHATGPT_WEB_TIMEOUT_MS: "600000",
  THEHOOD_CHATGPT_WEB_RUN_SCOPED_TARGETS: "1",
  THEHOOD_CHATGPT_WEB_KEEP_TARGET_ON_FAILURE: "1"
});

const localBridgePath = (cliPath: string | undefined): string =>
  path.resolve(path.dirname(path.resolve(cliPath ?? "dist/cli/main.js")), "..", "bridges", "chatgptWebBridge.js");

const localMcpCommand = (cliPath: string | undefined): string =>
  [process.execPath, path.resolve(cliPath ?? "dist/cli/main.js"), "mcp"].map(shellQuote).join(" ");

const formatTunnelInitCommand = (config: {
  profile: string;
  tunnelId: string;
  mcpCommand: string;
}): string => [
  "tunnel-client init \\",
  "  --sample sample_mcp_stdio_local \\",
  `  --profile ${shellQuote(config.profile)} \\`,
  `  --tunnel-id ${shellQuote(config.tunnelId)} \\`,
  `  --mcp-command ${shellQuote(config.mcpCommand)}`
].join("\n");

const buildTunnelLaunchConfig = (
  profile: string,
  tunnelId: string,
  mcpCommand: string
): McpTunnelLaunchConfig => ({
  profile,
  tunnelId,
  mcpCommand,
  initCommand: formatTunnelInitCommand({ profile, tunnelId, mcpCommand }),
  doctorCommand: `tunnel-client doctor --profile ${shellQuote(profile)} --explain`,
  runCommand: `tunnel-client run --profile ${shellQuote(profile)}`
});

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

export const getMcpTunnelConfigReport = (
  cliPath: string | undefined,
  options: McpTunnelConfigOptions = {}
): McpTunnelConfigReport => {
  const profile = options.profile ?? "thehood-local";
  const tunnelId = options.tunnelId ?? "<tunnel-id>";

  return {
    installed: buildTunnelLaunchConfig(profile, tunnelId, "thehood mcp"),
    local: buildTunnelLaunchConfig(profile, tunnelId, localMcpCommand(cliPath)),
    chatGptSteps: [
      "Enable ChatGPT Developer Mode in Settings -> Apps & Connectors -> Advanced settings.",
      "Create a connector and choose Tunnel as the connection type.",
      "Select the tunnel id used above, then create or refresh the connector.",
      "In a new chat, open the + menu, choose More, and enable the TheHood connector.",
      "Validate the connector by asking ChatGPT to call thehood_doctor for your repo_path, then a read-only repo gateway tool such as thehood_repo_tree."
    ],
    notes: [
      "Keep tunnel-client run active while ChatGPT uses the connector.",
      "TheHood remains the local runtime and repo gateway; ChatGPT receives only tool results it calls.",
      "This MCP connector path is separate from the chatgpt-web agent bridge and does not use Chrome, CDP, or THEHOOD_CHATGPT_WEB_* variables.",
      "Use trusted MCP hosts for private repos because connector tool results can disclose repo and run data.",
      "Prefer the local build command while developing this checkout, and the installed command after publishing the package."
    ]
  };
};
