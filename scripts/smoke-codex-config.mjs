import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const baseEnv = {
  ...process.env,
  THEHOOD_CHATGPT_WEB_COMMAND: "",
  THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED: "0",
  THEHOOD_CHATGPT_WEB_ALLOW_UNVERIFIED_MODEL: "0",
  THEHOOD_CHATGPT_WEB_CDP_URL: "http://127.0.0.1:9"
};

const readOption = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }

  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
};

const optionalOption = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
};

const configOption = optionalOption("--config");
const repoOption = optionalOption("--repo");
const defaultConfigPath = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml");
const configPath = path.resolve(
  configOption ?? defaultConfigPath
);
let repoPath = path.resolve(repoOption ?? root);
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sectionBody = (source, sectionName) => {
  const headerPattern = new RegExp(`^\\[${escapeRegExp(sectionName)}\\]\\s*$`, "m");
  const match = headerPattern.exec(source);

  if (!match) {
    return undefined;
  }

  const start = match.index + match[0].length;
  const rest = source.slice(start);
  const nextHeader = rest.search(/^\[/m);
  return (nextHeader === -1 ? rest : rest.slice(0, nextHeader)).trim();
};

const stripComment = (line) => {
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      quoted = !quoted;
      continue;
    }

    if (!quoted && char === "#") {
      return line.slice(0, index).trim();
    }
  }

  return line.trim();
};

const keyValues = (body) => {
  const entries = new Map();

  for (const rawLine of body.split("\n")) {
    const line = stripComment(rawLine);
    if (!line) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (match) {
      entries.set(match[1], match[2].trim());
    }
  }

  return entries;
};

const parseTomlString = (value, key) => {
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${key} as a TOML string: ${message}`);
  }
};

const parseStringArray = (value, key) => {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to the explicit error below.
  }

  throw new Error(`Could not parse ${key} as a string array.`);
};

const parseInlineEnv = (value) => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("env must be an inline TOML table when set under [mcp_servers.thehood].");
  }

  const env = {};
  const body = trimmed.slice(1, -1);
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:\\.|[^"\\])*")/g;
  let match;

  while ((match = pattern.exec(body)) !== null) {
    env[match[1]] = parseTomlString(match[2], `env.${match[1]}`);
  }

  return env;
};

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
};

const createFixtureRepo = async () => {
  const fixtureRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-codex-config-smoke-repo-"));
  await fs.writeFile(path.join(fixtureRepoPath, "README.md"), "# TheHood Codex config smoke\n", "utf8");
  await fs.mkdir(path.join(fixtureRepoPath, ".thehood"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRepoPath, ".thehood", "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        roles: {
          orchestrator: {
            provider: "stub",
            model: "orchestrator"
          },
          implementer: {
            provider: "stub",
            model: "implementer"
          },
          qa: {
            provider: "stub",
            model: "qa"
          },
          verifier: {
            provider: "stub",
            model: "verifier"
          },
          critic: {
            provider: "stub",
            model: "critic"
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return fixtureRepoPath;
};

const generatedLocalLaunch = () => ({
  command: process.execPath,
  args: [path.join(root, "dist", "cli", "main.js"), "mcp"],
  env: {}
});

const loadTheHoodConfig = async (filePath) => {
  const source = await fs.readFile(filePath, "utf8");
  const serverBody = sectionBody(source, "mcp_servers.thehood");
  assert.ok(serverBody, `Missing [mcp_servers.thehood] in ${filePath}`);

  const values = keyValues(serverBody);
  const commandValue = values.get("command");
  const argsValue = values.get("args");
  assert.ok(commandValue, "[mcp_servers.thehood] must define command.");
  assert.ok(argsValue, "[mcp_servers.thehood] must define args.");

  const env = {};
  const inlineEnv = values.get("env");
  if (inlineEnv) {
    Object.assign(env, parseInlineEnv(inlineEnv));
  }

  const envBody = sectionBody(source, "mcp_servers.thehood.env");
  if (envBody) {
    for (const [key, value] of keyValues(envBody)) {
      env[key] = parseTomlString(value, `env.${key}`);
    }
  }

  return {
    command: parseTomlString(commandValue, "command"),
    args: parseStringArray(argsValue, "args"),
    env
  };
};

const runMcp = async (launch, messages) => {
  const child = spawn(launch.command, launch.args, {
    cwd: root,
    env: {
      ...baseEnv,
      ...launch.env
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, 30_000);

  for (const message of messages) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  child.stdin.end();

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });
  clearTimeout(timeout);

  assert.equal(exitCode, 0, stderr || stdout);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const loadSmokeLaunch = async () => {
  if (await fileExists(configPath)) {
    return {
      launch: await loadTheHoodConfig(configPath),
      configLabel: configPath
    };
  }

  if (configOption) {
    throw new Error(`Config file does not exist: ${configPath}`);
  }

  if (!repoOption) {
    repoPath = await createFixtureRepo();
  }

  return {
    launch: generatedLocalLaunch(),
    configLabel: `generated local fixture (missing ${configPath})`
  };
};

const { launch, configLabel } = await loadSmokeLaunch();
const baseMessages = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "thehood-codex-config-smoke",
        version: "0.0.0"
      }
    }
  },
  {
    jsonrpc: "2.0",
    method: "notifications/initialized"
  }
];

const responses = await runMcp(launch, [
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  },
  {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "thehood_doctor",
      arguments: {
        repo_path: repoPath
      }
    }
  }
]);

const initialize = responses.find((response) => response.id === 1);
const toolsList = responses.find((response) => response.id === 2);
const doctor = responses.find((response) => response.id === 3);
assert.equal(initialize.result.serverInfo.name, "thehood");
assert.equal(initialize.result.serverInfo.version, packageJson.version);

const toolNames = toolsList.result.tools.map((tool) => tool.name);
for (const expectedTool of [
  "thehood_doctor",
  "thehood_roles",
  "thehood_model_access",
  "thehood_pro_access",
  "thehood_recommend_loop",
  "thehood_agent_board",
  "thehood_assign_roles",
  "thehood_plan",
  "thehood_orchestrate",
  "thehood_consult",
  "thehood_summon",
  "thehood_continue",
  "thehood_status",
  "thehood_runs",
  "thehood_read_artifact",
  "thehood_capture_evidence",
  "thehood_fanout",
  "thehood_loop",
  "thehood_abort"
]) {
  assert.ok(toolNames.includes(expectedTool), `tools/list should expose ${expectedTool}`);
}

const health = doctor.result.structuredContent;
assert.equal(health.runtime.name, "thehood");
for (const expectedCapability of [
  "structured_mcp_next_actions",
  "approval_artifact_next_actions",
  "protected_integrated_patch_gate",
  "cli_artifact_reads",
  "approval_phrase_enforcement",
  "final_report_artifacts",
  "mcp_final_report_next_action",
  "provider_directive_ack",
  "max_iteration_enforcement",
  "validation_command_capture",
  "chatgpt_browser_manager",
  "chatgpt_web_bridge_fail_fast",
  "chatgpt_web_session_isolation",
  "chatgpt_web_auth_readiness",
  "branded_tui_shell",
  "operator_next_actions",
  "crew_lane_trail",
  "revision_trail",
  "runtime_loop_runner",
  "autopilot_approval_policy",
  "mcp_autopilot_continue_guidance",
  "run_status_insights",
  "same_run_agent_summons",
  "bounded_same_run_fanout",
  "loop_recommendation_router",
  "codex_loop_plan_artifact",
  "pro_access_preflight",
  "model_access_preflight",
  "codex_agent_board",
  "codex_agent_board_artifact"
]) {
  assert.ok(
    health.runtime.capabilities.includes(expectedCapability),
    `doctor runtime capabilities should include ${expectedCapability}`
  );
}

const activeRoles = ["orchestrator", "implementer", "verifier", "critic"];
for (const role of activeRoles) {
  const roleHealth = health.roles.find((candidate) => candidate.role === role);
  assert.ok(roleHealth, `doctor should report ${role}.`);
  assert.deepEqual(roleHealth.issues, [], `${role} should have no doctor issues.`);
}

process.stdout.write(
  [
    "Codex config MCP smoke passed.",
    `config: ${configLabel}`,
    `repo: ${repoPath}`,
    `server: ${launch.command} ${launch.args.join(" ")}`,
    `capabilities: ${health.runtime.capabilities.join(", ")}`,
    `tools: ${toolNames.join(", ")}`
  ].join("\n") + "\n"
);
