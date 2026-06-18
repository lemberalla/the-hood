import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cliPath = path.join(root, "dist", "cli", "main.js");
const chatGptBridgePath = path.join(root, "dist", "bridges", "chatgptWebBridge.js");

const runCli = async (args, options = {}) => {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: root,
    env: {
      ...process.env,
      ...(options.env ?? {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });

  if (options.expectExitCode !== undefined) {
    assert.equal(exitCode, options.expectExitCode, stderr || stdout);
  } else {
    assert.equal(exitCode, 0, stderr || stdout);
  }

  return {
    stdout,
    stderr,
    exitCode
  };
};

const runNodeScript = async (scriptPath, args, stdin = "", options = {}) => {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: root,
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

  child.stdin.end(stdin);

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });

  assert.equal(exitCode, options.expectExitCode ?? 0, stderr || stdout);

  return {
    stdout,
    stderr,
    exitCode
  };
};

const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-runtime-smoke-"));
const mcpConfig = await runCli(["mcp", "config", "--json"]);
const mcpConfigResult = JSON.parse(mcpConfig.stdout);
assert.equal(mcpConfigResult.installed.command, "thehood");
assert.deepEqual(mcpConfigResult.installed.args, ["mcp"]);
assert.equal(mcpConfigResult.local.command, process.execPath);
assert.equal(mcpConfigResult.local.args.at(-1), "mcp");
const chatGptMcpConfig = await runCli(["mcp", "config", "--chatgpt-web", "--json"]);
const chatGptMcpConfigResult = JSON.parse(chatGptMcpConfig.stdout);
assert.equal(
  chatGptMcpConfigResult.installed.env.THEHOOD_CHATGPT_WEB_COMMAND,
  "thehood-chatgpt-web-bridge"
);
assert.equal(chatGptMcpConfigResult.installed.env.THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED, "1");
assert.equal(chatGptMcpConfigResult.installed.env.THEHOOD_CHATGPT_WEB_CDP_URL, "http://127.0.0.1:9222");
assert.equal(chatGptMcpConfigResult.installed.env.THEHOOD_CHATGPT_WEB_TIMEOUT_MS, "300000");
assert.equal(chatGptMcpConfigResult.installed.startupTimeoutSec, 120);
assert.equal(chatGptMcpConfigResult.local.env.THEHOOD_CHATGPT_WEB_COMMAND, chatGptBridgePath);
assert.equal(chatGptMcpConfigResult.local.env.THEHOOD_CHATGPT_WEB_TIMEOUT_MS, "300000");
assert.equal(chatGptMcpConfigResult.local.startupTimeoutSec, 120);
assert.ok(chatGptMcpConfigResult.localToml.includes("THEHOOD_CHATGPT_WEB_COMMAND"));
assert.ok(chatGptMcpConfigResult.localToml.includes("THEHOOD_CHATGPT_WEB_TIMEOUT_MS"));
assert.ok(chatGptMcpConfigResult.localToml.includes("startup_timeout_sec = 120"));
await runCli(["init", "--repo", repoPath]);
const doctor = await runCli(["doctor", "--repo", repoPath, "--json"]);
const doctorResult = JSON.parse(doctor.stdout);
const stubHealth = doctorResult.providers.find((provider) => provider.id === "stub");
assert.equal(stubHealth.implemented, true);
assert.deepEqual(stubHealth.issues, []);
const defaultOrchestratorHealth = doctorResult.roles.find((role) => role.role === "orchestrator");
assert.equal(defaultOrchestratorHealth.providerImplemented, true);
assert.ok(defaultOrchestratorHealth.issues.includes("bridge_command_not_configured"));
const unconfirmedDoctor = await runCli(["doctor", "--repo", repoPath, "--json"], {
  env: {
    THEHOOD_CHATGPT_WEB_COMMAND: chatGptBridgePath,
    THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED: "0",
    THEHOOD_CHATGPT_WEB_ALLOW_UNVERIFIED_MODEL: "0"
  }
});
const unconfirmedDoctorResult = JSON.parse(unconfirmedDoctor.stdout);
const unconfirmedChatGptProvider = unconfirmedDoctorResult.providers.find((provider) => provider.id === "chatgpt-web");
assert.equal(unconfirmedChatGptProvider.commandFound, true);
assert.deepEqual(unconfirmedChatGptProvider.issues, ["model_not_confirmed"]);
const cdpServer = http.createServer((request, response) => {
  if (request.url === "/json/list") {
    response.writeHead(200, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify([
      {
        url: "https://chatgpt.com/",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/smoke"
      }
    ]));
    return;
  }

  response.writeHead(404);
  response.end();
});
await new Promise((resolve) => cdpServer.listen(0, "127.0.0.1", resolve));
const cdpAddress = cdpServer.address();
assert.ok(cdpAddress && typeof cdpAddress === "object");
const readyDoctor = await runCli(["doctor", "--repo", repoPath, "--json"], {
  env: {
    THEHOOD_CHATGPT_WEB_COMMAND: chatGptBridgePath,
    THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED: "1",
    THEHOOD_CHATGPT_WEB_CDP_URL: `http://127.0.0.1:${cdpAddress.port}`
  }
});
await new Promise((resolve, reject) => {
  cdpServer.close((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve(undefined);
  });
});
const readyDoctorResult = JSON.parse(readyDoctor.stdout);
const readyChatGptProvider = readyDoctorResult.providers.find((provider) => provider.id === "chatgpt-web");
const readyOrchestrator = readyDoctorResult.roles.find((role) => role.role === "orchestrator");
assert.deepEqual(readyChatGptProvider.issues, []);
assert.deepEqual(readyOrchestrator.issues, []);
const blockedChatGptPlan = JSON.parse((await runCli(["plan", "block missing ChatGPT bridge", "--repo", repoPath, "--json"])).stdout);
const blockedChatGptContinue = JSON.parse((await runCli(["continue", blockedChatGptPlan.runId, "--repo", repoPath, "--json"])).stdout);
assert.equal(blockedChatGptContinue.run.state, "awaiting_approval");
assert.equal(blockedChatGptContinue.providerResponses[0].status, "blocked");
assert.ok(blockedChatGptContinue.run.approvalReason.includes("ChatGPT Web bridge command is not configured"));
await runCli(["exec", "missing-run", "--repo", repoPath, "--", "git", "init"], { expectExitCode: 1 });

const chatGptBridgeSchemaPath = path.join(repoPath, "chatgpt-bridge.schema.json");
await fs.writeFile(
  chatGptBridgeSchemaPath,
  JSON.stringify({
    type: "object",
    properties: {
      data: {
        type: "object",
        required: ["decision"]
      }
    }
  }),
  "utf8"
);
const unconfirmedBridge = JSON.parse(
  (
    await runNodeScript(
      chatGptBridgePath,
      ["--model", "chatgpt-pro", "--schema", chatGptBridgeSchemaPath],
      "Return a plan."
    )
  ).stdout
);
assert.equal(unconfirmedBridge.status, "blocked");
assert.equal(unconfirmedBridge.data.decision.action, "request_approval");
assert.ok(unconfirmedBridge.summary.includes("requires explicit model confirmation"));

const strandedPlan = JSON.parse(
  (
    await runCli([
      "plan",
      "resume a stranded read-only planning run",
      "--repo",
      repoPath,
      "--orchestrator",
      "stub:orchestrator",
      "--json"
    ])
  ).stdout
);
const strandedRunPath = path.join(repoPath, ".thehood", "runs", strandedPlan.runId, "run.json");
const strandedRun = JSON.parse(await fs.readFile(strandedRunPath, "utf8"));
await fs.writeFile(
  strandedRunPath,
  `${JSON.stringify({
    ...strandedRun,
    state: "planning",
    events: [
      ...strandedRun.events,
      {
        id: "event_smoke_stranded_planning",
        createdAt: strandedRun.updatedAt,
        type: "state_changed",
        message: "Smoke forced a stranded planning state."
      }
    ]
  }, null, 2)}\n`,
  "utf8"
);
const resumedPlan = JSON.parse((await runCli(["continue", strandedPlan.runId, "--repo", repoPath, "--json"])).stdout);
assert.equal(resumedPlan.run.state, "completed");
assert.equal(resumedPlan.providerResponses.length, 1);
assert.equal(resumedPlan.providerResponses[0].status, "ok");

await fs.writeFile(path.join(repoPath, "README.md"), "# Smoke Repo\n\nProvider milestone notes.\n", "utf8");
await fs.mkdir(path.join(repoPath, "src", "providers"), { recursive: true });
await fs.writeFile(
  path.join(repoPath, "src", "providers", "example.ts"),
  "export const provider = 'context-smoke';\n",
  "utf8"
);
const repoContextPlan = JSON.parse(
  (
    await runCli([
      "plan",
      "repo-context-smoke plan provider milestone",
      "--repo",
      repoPath,
      "--orchestrator",
      "stub:orchestrator",
      "--json"
    ])
  ).stdout
);
const repoContextContinue = JSON.parse(
  (await runCli(["continue", repoContextPlan.runId, "--repo", repoPath, "--json"])).stdout
);
assert.equal(repoContextContinue.run.state, "completed");
assert.equal(repoContextContinue.providerResponses.length, 2);
assert.equal(repoContextContinue.providerResponses[0].data.decision.action, "delegate");
assert.equal(repoContextContinue.providerResponses[1].data.decision.action, "complete");
const contextArtifact = repoContextContinue.run.artifacts.find((artifact) => artifact.kind === "context");
assert.ok(contextArtifact, "repo context artifact should be captured after delegate response");
const repoContext = JSON.parse(await fs.readFile(contextArtifact.ref, "utf8"));
assert.equal(repoContext.kind, "repo_context");
assert.ok(repoContext.tree.includes("README.md"));
assert.ok(repoContext.files.some((file) => file.path === "README.md"));

const plan = await runCli(["plan", "capture runtime evidence", "--repo", repoPath, "--json"]);
const run = JSON.parse(plan.stdout);

await runCli(["exec", run.runId, "--repo", repoPath, "--", "git", "init"]);

await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
await fs.mkdir(path.join(repoPath, "tests"), { recursive: true });
await fs.writeFile(path.join(repoPath, "src", "app.ts"), "export const value = 1;\n", "utf8");
await fs.writeFile(path.join(repoPath, "tests", "app.test.ts"), "expect(1).toBe(1);\n", "utf8");

const evidence = await runCli(["evidence", run.runId, "--repo", repoPath, "--json"]);
const evidenceResult = JSON.parse(evidence.stdout);

assert.ok(evidenceResult.changedPaths.includes("src/app.ts"));
assert.ok(evidenceResult.changedPaths.includes("tests/app.test.ts"));
assert.deepEqual(evidenceResult.protectedChanges, [
  {
    path: "tests/app.test.ts",
    pattern: "**/tests/**"
  }
]);

const command = await runCli(["exec", run.runId, "--repo", repoPath, "--json", "--", "node", "--version"]);
const commandResult = JSON.parse(command.stdout);
assert.equal(commandResult.event.exitCode, 0);
assert.equal(commandResult.event.command, "node");
assert.ok(commandResult.event.stdoutRef.endsWith(".stdout.txt"));

await runCli(["exec", run.runId, "--repo", repoPath, "--", "rm", "src/app.ts"], {
  expectExitCode: 3
});

const loopRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-loop-smoke-"));
await runCli(["init", "--repo", loopRepoPath]);
const loopRunOutput = await runCli([
  "run",
  "exercise deterministic loop",
  "--repo",
  loopRepoPath,
  "--orchestrator",
  "stub:orchestrator",
  "--implementer",
  "stub:implementer",
  "--verifier",
  "stub:verifier",
  "--critic",
  "stub:critic",
  "--json"
]);
const loopRun = JSON.parse(loopRunOutput.stdout);
assert.equal(loopRun.state, "awaiting_approval");

await runCli(["approve", loopRun.runId, "--repo", loopRepoPath, "--reason", "smoke-approved"]);
const loopContinue = await runCli(["continue", loopRun.runId, "--repo", loopRepoPath, "--json"]);
const loopResult = JSON.parse(loopContinue.stdout);
assert.equal(loopResult.run.state, "completed");
assert.equal(loopResult.providerResponses.length, 3);
const directiveArtifacts = loopResult.run.artifacts.filter((artifact) => artifact.kind === "directive");
assert.equal(directiveArtifacts.length, 3);
const verifierDirectiveArtifact = directiveArtifacts.find((artifact) => artifact.summary.startsWith("verifier directive"));
assert.ok(verifierDirectiveArtifact, "verifier directive artifact should be captured");
const verifierDirective = JSON.parse(await fs.readFile(verifierDirectiveArtifact.ref, "utf8"));
assert.equal(verifierDirective.toolPermissions.edit, false);
assert.equal(verifierDirective.outputContract.requiredDataKey, "verificationResult");

const { createFallbackAgentResponse, parseLocalAgentOutput } = await import(
  pathToFileURL(path.join(root, "dist", "providers", "localCommand.js")).href
);
const { buildCodexCliArgs } = await import(pathToFileURL(path.join(root, "dist", "providers", "codexCli.js")).href);
const { buildClaudeCodeArgs } = await import(
  pathToFileURL(path.join(root, "dist", "providers", "claudeCode.js")).href
);
const fakeVerifierRequest = {
  role: "verifier",
  assignment: {
    provider: "codex-cli",
    model: "default"
  },
  run: {
    repoPath: loopRepoPath
  },
  directive: {
    toolPermissions: {
      read: true,
      edit: false,
      shell: true,
      network: false
    },
    outputContract: {
      schemaVersion: 1,
      name: "verification_result",
      requiredDataKey: "verificationResult"
    }
  }
};
const parsedProviderOutput = parseLocalAgentOutput(
  JSON.stringify({
    status: "ok",
    summary: "verified",
    data: {
      verificationResult: {
        verdict: "approve",
        summary: "ok"
      }
    }
  })
);
assert.ok(parsedProviderOutput, "local provider JSON output should parse");
assert.equal(parsedProviderOutput.data.verificationResult.verdict, "approve");
const fallbackProviderOutput = createFallbackAgentResponse(fakeVerifierRequest, {
  status: "blocked",
  summary: "not-json"
});
assert.equal(fallbackProviderOutput.data.verificationResult.verdict, "ask_user");
const schemaContext = {
  schema: {
    type: "object"
  },
  schemaPath: path.join(loopRepoPath, "agent-response.schema.json"),
  workspacePath: loopRepoPath
};
const codexArgs = buildCodexCliArgs(fakeVerifierRequest, schemaContext);
assert.deepEqual(codexArgs.slice(0, 5), ["exec", "--cd", loopRepoPath, "--sandbox", "read-only"]);
assert.equal(codexArgs.includes("--output-schema"), true);
assert.equal(codexArgs[codexArgs.indexOf("--output-schema") + 1], schemaContext.schemaPath);
assert.equal(codexArgs.at(-1), "-");
const claudeArgs = buildClaudeCodeArgs(fakeVerifierRequest, schemaContext);
assert.ok(claudeArgs.includes("--print"));
assert.equal(claudeArgs.includes("--json-schema"), true);
assert.ok(claudeArgs.includes("Read,Glob,Grep,Bash"));
assert.equal(claudeArgs.includes("-"), false);

const blockedRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-blocked-edit-smoke-"));
await runCli(["init", "--repo", blockedRepoPath]);
const blockedRunOutput = await runCli([
  "run",
  "block isolated local edits outside git",
  "--repo",
  blockedRepoPath,
  "--orchestrator",
  "stub:orchestrator",
  "--implementer",
  "claude-code:default",
  "--verifier",
  "stub:verifier",
  "--critic",
  "stub:critic",
  "--json"
]);
const blockedRun = JSON.parse(blockedRunOutput.stdout);
await runCli(["approve", blockedRun.runId, "--repo", blockedRepoPath, "--reason", "smoke-approved"]);
const blockedContinue = await runCli(["continue", blockedRun.runId, "--repo", blockedRepoPath, "--json"]);
const blockedResult = JSON.parse(blockedContinue.stdout);
assert.equal(blockedResult.run.state, "awaiting_approval");
assert.equal(blockedResult.run.approvalRequired, true);
assert.ok(blockedResult.run.approvalReason.includes("Isolated edit-capable local agent execution requires a git repository"));
assert.equal(blockedResult.providerResponses.at(-1).status, "blocked");

process.stdout.write(`Runtime smoke passed using ${repoPath}\n`);
