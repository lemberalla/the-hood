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
const tunnelConfig = await runCli([
  "mcp",
  "tunnel",
  "--profile",
  "thehood-smoke",
  "--tunnel-id",
  "tunnel_smoke",
  "--json"
]);
const tunnelConfigResult = JSON.parse(tunnelConfig.stdout);
assert.equal(tunnelConfigResult.installed.profile, "thehood-smoke");
assert.equal(tunnelConfigResult.installed.tunnelId, "tunnel_smoke");
assert.equal(tunnelConfigResult.installed.mcpCommand, "thehood mcp");
assert.ok(tunnelConfigResult.installed.initCommand.includes("--sample sample_mcp_stdio_local"));
assert.ok(tunnelConfigResult.installed.initCommand.includes("--mcp-command 'thehood mcp'"));
assert.ok(tunnelConfigResult.local.mcpCommand.includes(cliPath));
assert.equal(tunnelConfigResult.local.runCommand, "tunnel-client run --profile thehood-smoke");
assert.ok(tunnelConfigResult.chatGptSteps.some((step) => step.includes("Developer Mode")));
const tunnelConfigText = await runCli(["mcp", "tunnel"]);
assert.ok(tunnelConfigText.stdout.includes("installed package tunnel:"));
assert.ok(tunnelConfigText.stdout.includes("local build tunnel:"));
assert.ok(tunnelConfigText.stdout.includes("ChatGPT connector:"));
await runCli(["init", "--repo", repoPath]);
const doctor = await runCli(["doctor", "--repo", repoPath, "--json"]);
const doctorResult = JSON.parse(doctor.stdout);
assert.equal(doctorResult.runtime.name, "thehood");
assert.ok(doctorResult.runtime.capabilities.includes("approval_artifact_next_actions"));
assert.ok(doctorResult.runtime.capabilities.includes("protected_integrated_patch_gate"));
assert.ok(doctorResult.runtime.capabilities.includes("cli_artifact_reads"));
assert.ok(doctorResult.runtime.capabilities.includes("approval_phrase_enforcement"));
assert.ok(doctorResult.runtime.capabilities.includes("final_report_artifacts"));
assert.ok(doctorResult.runtime.capabilities.includes("mcp_final_report_next_action"));
assert.ok(doctorResult.runtime.capabilities.includes("max_iteration_enforcement"));
assert.ok(doctorResult.runtime.capabilities.includes("validation_command_capture"));
assert.ok(doctorResult.runtime.capabilities.includes("chatgpt_browser_manager"));
assert.ok(doctorResult.runtime.capabilities.includes("branded_tui_shell"));
assert.ok(doctorResult.runtime.capabilities.includes("approval_inbox_tui"));
assert.ok(doctorResult.runtime.capabilities.includes("provider_access_modes"));
assert.ok(doctorResult.runtime.capabilities.includes("mcp_repo_gateway_tools"));
assert.ok(doctorResult.runtime.capabilities.includes("chatgpt_mcp_connector_mode"));
const stubHealth = doctorResult.providers.find((provider) => provider.id === "stub");
assert.equal(stubHealth.implemented, true);
assert.deepEqual(stubHealth.issues, []);
assert.deepEqual(stubHealth.accessModes, ["agent-bridge"]);
const chatGptHealth = doctorResult.providers.find((provider) => provider.id === "chatgpt-web");
assert.ok(chatGptHealth.accessModes.includes("agent-bridge"));
assert.ok(chatGptHealth.accessModes.includes("mcp-connector"));
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
const browserStatus = JSON.parse(
  (await runCli(["browser", "status", "--cdp-url", `http://127.0.0.1:${cdpAddress.port}`, "--json"])).stdout
);
assert.equal(browserStatus.provider, "chatgpt-web");
assert.equal(browserStatus.cdpReachable, true);
assert.equal(browserStatus.chatGptTabFound, true);
assert.equal(browserStatus.readyForBridge, true);
const dashboard = await runCli(["ui", "--repo", repoPath, "--cdp-url", `http://127.0.0.1:${cdpAddress.port}`]);
assert.ok(dashboard.stdout.includes("THEHOOD"));
assert.ok(dashboard.stdout.includes("ChatGPT Web"));
assert.ok(dashboard.stdout.includes("CDP         reachable"));
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
const blockedChatGptInvocation = JSON.parse(
  (await runCli(["continue", blockedChatGptPlan.runId, "--repo", repoPath, "--json"])).stdout
);
assert.equal(blockedChatGptInvocation.run.state, "awaiting_approval");
assert.equal(blockedChatGptInvocation.providerResponses[0].status, "blocked");
assert.ok(blockedChatGptInvocation.run.approvalReason.includes("Invoking chatgpt-web:chatgpt-pro"));
await runCli(
  [
    "approve",
    blockedChatGptPlan.runId,
    "--repo",
    repoPath,
    "--reason",
    "I approve the next thing without the required phrase."
  ],
  { expectExitCode: 2 }
);
const stillBlockedChatGptInvocation = JSON.parse(
  (await runCli(["status", blockedChatGptPlan.runId, "--repo", repoPath, "--json"])).stdout
);
assert.equal(stillBlockedChatGptInvocation.state, "awaiting_approval");
await runCli([
  "approve",
  blockedChatGptPlan.runId,
  "--repo",
  repoPath,
  "--reason",
  "I approve invoke chatgpt-web for missing bridge smoke."
]);
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
const repoContextFinalReportArtifact = repoContextContinue.run.artifacts.find(
  (artifact) => artifact.kind === "report" && artifact.summary.includes("Final report")
);
assert.ok(repoContextFinalReportArtifact, "read-only completed run should attach a final report");
const contextArtifact = repoContextContinue.run.artifacts.find((artifact) => artifact.kind === "context");
assert.ok(contextArtifact, "repo context artifact should be captured after delegate response");
const repoContext = JSON.parse(await fs.readFile(contextArtifact.ref, "utf8"));
assert.equal(repoContext.kind, "repo_context");
assert.ok(repoContext.tree.includes("README.md"));
assert.ok(repoContext.files.some((file) => file.path === "README.md"));
const contextArtifactRead = await runCli([
  "artifact",
  repoContextPlan.runId,
  contextArtifact.ref,
  "--repo",
  repoPath,
  "--max-bytes",
  "100000"
]);
assert.ok(contextArtifactRead.stdout.includes('"kind": "repo_context"'));
const contextArtifactJson = JSON.parse(
  (
    await runCli([
      "artifact",
      repoContextPlan.runId,
      contextArtifact.ref,
      "--repo",
      repoPath,
      "--max-bytes",
      "100000",
      "--json"
    ])
  ).stdout
);
assert.equal(contextArtifactJson.artifact.kind, "context");
assert.equal(contextArtifactJson.truncated, false);

const fakeExternalBridgePath = path.join(repoPath, "fake-external-chatgpt.mjs");
const fakeExternalBridgeLogPath = path.join(repoPath, "fake-external-chatgpt.log");
await fs.writeFile(
  fakeExternalBridgePath,
  [
    "#!/usr/bin/env node",
    "import fs from 'node:fs/promises';",
    "const logPath = process.env.THEHOOD_FAKE_CHATGPT_LOG;",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', async () => {",
    "  const hasRepoContext = input.includes('\"repoContext\"');",
    "  if (logPath) {",
    "    await fs.appendFile(logPath, hasRepoContext ? 'context\\n' : 'no-context\\n', 'utf8');",
    "  }",
    "  process.stdout.write(JSON.stringify({",
    "    status: 'ok',",
    "    summary: hasRepoContext ? 'fake ChatGPT received approved repo context' : 'fake ChatGPT requested repo context',",
    "    data: {",
    "      decision: hasRepoContext ? {",
    "        action: 'complete',",
    "        reason: 'Approved repo context was enough for a plan.'",
    "      } : {",
    "        action: 'delegate',",
    "        reason: 'Need bounded repo context before planning.',",
    "        delegate: {",
    "          role: 'repo_reader',",
    "          task: 'Capture bounded repo context for external planning.'",
    "        }",
    "      }",
    "    }",
    "  }));",
    "});",
    ""
  ].join("\n"),
  "utf8"
);
await fs.chmod(fakeExternalBridgePath, 0o755);
const fakeExternalEnv = {
  THEHOOD_CHATGPT_WEB_COMMAND: fakeExternalBridgePath,
  THEHOOD_FAKE_CHATGPT_LOG: fakeExternalBridgeLogPath
};
const externalContextPlan = JSON.parse(
  (
    await runCli(
      [
        "plan",
        "external-context-smoke plan provider milestone",
        "--repo",
        repoPath,
        "--orchestrator",
        "chatgpt-web:chatgpt-pro",
        "--json"
      ],
      {
        env: fakeExternalEnv
      }
    )
  ).stdout
);
const externalInvocationGate = JSON.parse(
  (await runCli(["continue", externalContextPlan.runId, "--repo", repoPath, "--json"], { env: fakeExternalEnv })).stdout
);
assert.equal(externalInvocationGate.run.state, "awaiting_approval");
assert.equal(externalInvocationGate.run.approvalRequired, true);
assert.ok(externalInvocationGate.run.approvalReason.includes("Invoking chatgpt-web:chatgpt-pro"));
assert.equal(externalInvocationGate.providerResponses[0].data.decision.action, "request_approval");
const approvalDashboard = await runCli(["ui", "--repo", repoPath]);
assert.ok(approvalDashboard.stdout.includes("Approval Gates"));
assert.ok(approvalDashboard.stdout.includes(externalContextPlan.runId));
assert.ok(approvalDashboard.stdout.includes("I approve invoke chatgpt-web"));
const approvalInbox = await runCli(["ui", "approvals", "--repo", repoPath]);
assert.ok(approvalInbox.stdout.includes("Approval Gates"));
assert.ok(approvalInbox.stdout.includes("[approve]"));
assert.ok(approvalInbox.stdout.includes(`--approve ${externalContextPlan.runId}`));
const approvalInboxJson = JSON.parse((await runCli(["ui", "approvals", "--repo", repoPath, "--json"])).stdout);
assert.ok(approvalInboxJson.some((approval) => approval.runId === externalContextPlan.runId));
const uiApprovalResult = JSON.parse(
  (await runCli(["ui", "approvals", "--repo", repoPath, "--approve", externalContextPlan.runId, "--json"])).stdout
);
assert.equal(uiApprovalResult.approvalEvents.at(-1).decision, "approve");
await assert.rejects(fs.readFile(fakeExternalBridgeLogPath, "utf8"));
const externalContextGate = JSON.parse(
  (await runCli(["continue", externalContextPlan.runId, "--repo", repoPath, "--json"], { env: fakeExternalEnv })).stdout
);
assert.equal(externalContextGate.run.state, "awaiting_approval");
assert.equal(externalContextGate.run.approvalRequired, true);
assert.ok(externalContextGate.run.approvalReason.includes("Sending repo context to chatgpt-web:chatgpt-pro"));
assert.equal(externalContextGate.providerResponses[0].data.decision.action, "delegate");
assert.equal(externalContextGate.providerResponses.at(-1).data.decision.action, "request_approval");
assert.deepEqual((await fs.readFile(fakeExternalBridgeLogPath, "utf8")).trim().split("\n"), ["no-context"]);
await runCli([
  "approve",
  externalContextPlan.runId,
  "--repo",
  repoPath,
  "--reason",
  "I approve send repo context to chatgpt-web for this read-only smoke."
]);
const externalContextApproved = JSON.parse(
  (await runCli(["continue", externalContextPlan.runId, "--repo", repoPath, "--json"], { env: fakeExternalEnv })).stdout
);
assert.equal(externalContextApproved.run.state, "completed");
assert.equal(externalContextApproved.providerResponses[0].data.decision.action, "complete");
assert.deepEqual((await fs.readFile(fakeExternalBridgeLogPath, "utf8")).trim().split("\n"), [
  "no-context",
  "context"
]);

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
await fs.writeFile(
  path.join(loopRepoPath, "package.json"),
  JSON.stringify(
    {
      scripts: {
        typecheck: "node -e \"process.stdout.write('validation ok\\\\n')\""
      }
    },
    null,
    2
  ),
  "utf8"
);
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
const finalReportArtifact = loopResult.run.artifacts.find(
  (artifact) => artifact.kind === "report" && artifact.summary.includes("Final report")
);
assert.ok(finalReportArtifact, "verified completed run should attach a final report");
const finalReport = JSON.parse(await fs.readFile(finalReportArtifact.ref, "utf8"));
assert.equal(finalReport.kind, "final_report");
assert.equal(finalReport.finalState, "completed");
assert.equal(finalReport.completedBy.role, "verifier");
assert.equal(finalReport.stopReason, "Verifier approved runtime evidence.");
const validationToolEvent = loopResult.run.toolEvents.find((event) => event.tool === "validation_typecheck");
assert.ok(validationToolEvent, "verification should capture the selected validation command");
assert.equal(validationToolEvent.command, "npm");
assert.deepEqual(validationToolEvent.args, ["run", "typecheck"]);
assert.equal(validationToolEvent.exitCode, 0);
const validationSummaryArtifact = loopResult.run.artifacts.find(
  (artifact) => artifact.kind === "metadata" && artifact.summary.includes("Validation summary")
);
assert.ok(validationSummaryArtifact, "verification should attach a validation summary artifact");
const validationSummary = JSON.parse(await fs.readFile(validationSummaryArtifact.ref, "utf8"));
assert.equal(validationSummary.executedCommands.length, 1);
assert.equal(validationSummary.executedCommands[0].script, "typecheck");
assert.equal(validationSummary.failedCommandCount, 0);
const directiveArtifacts = loopResult.run.artifacts.filter((artifact) => artifact.kind === "directive");
assert.equal(directiveArtifacts.length, 3);
const verifierDirectiveArtifact = directiveArtifacts.find((artifact) => artifact.summary.startsWith("verifier directive"));
assert.ok(verifierDirectiveArtifact, "verifier directive artifact should be captured");
const verifierDirective = JSON.parse(await fs.readFile(verifierDirectiveArtifact.ref, "utf8"));
assert.equal(verifierDirective.toolPermissions.edit, false);
assert.equal(verifierDirective.outputContract.requiredDataKey, "verificationResult");

const maxIterationRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-max-iterations-smoke-"));
await runCli(["init", "--repo", maxIterationRepoPath]);
const maxIterationConfigPath = path.join(maxIterationRepoPath, ".thehood", "config.json");
const maxIterationConfig = JSON.parse(await fs.readFile(maxIterationConfigPath, "utf8"));
await fs.writeFile(
  maxIterationConfigPath,
  `${JSON.stringify(
    {
      ...maxIterationConfig,
      defaults: {
        ...maxIterationConfig.defaults,
        maxIterations: 1
      }
    },
    null,
    2
  )}\n`,
  "utf8"
);
const maxIterationRun = JSON.parse(
  (
    await runCli([
      "run",
      "stop after one provider iteration",
      "--repo",
      maxIterationRepoPath,
      "--orchestrator",
      "stub:orchestrator",
      "--implementer",
      "stub:implementer",
      "--verifier",
      "stub:verifier",
      "--critic",
      "stub:critic",
      "--json"
    ])
  ).stdout
);
assert.equal(maxIterationRun.maxIterations, 1);
await runCli(["approve", maxIterationRun.runId, "--repo", maxIterationRepoPath, "--reason", "smoke-approved"]);
const maxIterationContinue = JSON.parse(
  (await runCli(["continue", maxIterationRun.runId, "--repo", maxIterationRepoPath, "--json"])).stdout
);
assert.equal(maxIterationContinue.run.state, "failed");
assert.ok(maxIterationContinue.run.stopReason.includes("Max iterations reached (1/1)."));
assert.equal(maxIterationContinue.providerResponses.length, 1);
assert.equal(maxIterationContinue.providerResponses[0].data.decision.action, "delegate");
assert.equal(
  maxIterationContinue.run.events.filter((event) => event.type === "agent_response").length,
  1
);
assert.ok(
  maxIterationContinue.run.events.some(
    (event) => event.type === "run_failed" && event.data?.reason === "max_iterations"
  )
);

const failingValidationRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-validation-fail-smoke-"));
await runCli(["init", "--repo", failingValidationRepoPath]);
await fs.writeFile(
  path.join(failingValidationRepoPath, "package.json"),
  JSON.stringify(
    {
      scripts: {
        typecheck: "node -e \"process.exit(7)\""
      }
    },
    null,
    2
  ),
  "utf8"
);
const failingValidationRun = JSON.parse(
  (
    await runCli([
      "run",
      "stop on failing validation evidence",
      "--repo",
      failingValidationRepoPath,
      "--orchestrator",
      "stub:orchestrator",
      "--implementer",
      "stub:implementer",
      "--verifier",
      "stub:verifier",
      "--critic",
      "stub:critic",
      "--json"
    ])
  ).stdout
);
await runCli(["approve", failingValidationRun.runId, "--repo", failingValidationRepoPath, "--reason", "smoke-approved"]);
const failingValidationContinue = JSON.parse(
  (await runCli(["continue", failingValidationRun.runId, "--repo", failingValidationRepoPath, "--json"])).stdout
);
assert.equal(failingValidationContinue.run.state, "awaiting_approval");
assert.ok(failingValidationContinue.run.approvalReason.includes("Verifier returned ask_user"));
const failingValidationToolEvent = failingValidationContinue.run.toolEvents.find(
  (event) => event.tool === "validation_typecheck"
);
assert.ok(failingValidationToolEvent, "failing validation should still be captured");
assert.equal(failingValidationToolEvent.exitCode, 7);
assert.equal(
  failingValidationContinue.providerResponses.at(-1).data.verificationResult.summary,
  "Runtime validation commands failed; user review is required."
);
assert.ok(
  !failingValidationContinue.run.artifacts.some(
    (artifact) => artifact.kind === "report" && artifact.summary.includes("Final report")
  ),
  "failing validation should not produce a final report"
);

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
