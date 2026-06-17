import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cliPath = path.join(root, "dist", "cli", "main.js");

const runCli = async (args, options = {}) => {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: root,
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

const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-runtime-smoke-"));
const mcpConfig = await runCli(["mcp", "config", "--json"]);
const mcpConfigResult = JSON.parse(mcpConfig.stdout);
assert.equal(mcpConfigResult.installed.command, "thehood");
assert.deepEqual(mcpConfigResult.installed.args, ["mcp"]);
assert.equal(mcpConfigResult.local.command, process.execPath);
assert.equal(mcpConfigResult.local.args.at(-1), "mcp");
await runCli(["init", "--repo", repoPath]);
const doctor = await runCli(["doctor", "--repo", repoPath, "--json"]);
const doctorResult = JSON.parse(doctor.stdout);
const stubHealth = doctorResult.providers.find((provider) => provider.id === "stub");
assert.equal(stubHealth.implemented, true);
assert.deepEqual(stubHealth.issues, []);
const defaultOrchestratorHealth = doctorResult.roles.find((role) => role.role === "orchestrator");
assert.ok(defaultOrchestratorHealth.issues.includes("provider_not_implemented"));
await runCli(["exec", "missing-run", "--repo", repoPath, "--", "git", "init"], { expectExitCode: 1 });

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
  schemaPath: path.join(loopRepoPath, "agent-response.schema.json")
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
  "block direct local edits",
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
assert.ok(blockedResult.run.approvalReason.includes("Direct edit-capable local agent execution is blocked"));
assert.equal(blockedResult.providerResponses.at(-1).status, "blocked");

process.stdout.write(`Runtime smoke passed using ${repoPath}\n`);
