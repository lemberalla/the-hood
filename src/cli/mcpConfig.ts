import path from "node:path";

export interface McpLaunchConfig {
  command: string;
  args: string[];
}

export interface McpConfigReport {
  installed: McpLaunchConfig;
  local: McpLaunchConfig;
  installedToml: string;
  localToml: string;
}

const quoteTomlString = (value: string): string =>
  JSON.stringify(value);

const formatToml = (config: McpLaunchConfig): string => [
  "[mcp_servers.thehood]",
  `command = ${quoteTomlString(config.command)}`,
  `args = [${config.args.map(quoteTomlString).join(", ")}]`
].join("\n");

export const getMcpConfigReport = (cliPath: string | undefined): McpConfigReport => {
  const installed: McpLaunchConfig = {
    command: "thehood",
    args: ["mcp"]
  };
  const local: McpLaunchConfig = {
    command: process.execPath,
    args: [path.resolve(cliPath ?? "dist/cli/main.js"), "mcp"]
  };

  return {
    installed,
    local,
    installedToml: formatToml(installed),
    localToml: formatToml(local)
  };
};
