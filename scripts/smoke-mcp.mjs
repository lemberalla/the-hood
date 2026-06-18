import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cliPath = path.join(root, "dist", "cli", "main.js");

const runCommand = async (args) => {
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

  assert.equal(exitCode, 0, stderr || stdout);
  return stdout;
};

const runRawCommand = async (command, args, cwd) => {
  const child = spawn(command, args, {
    cwd,
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

  assert.equal(exitCode, 0, stderr || stdout);
  return stdout;
};

const runMcp = async (messages) => {
  const child = spawn(process.execPath, [cliPath, "mcp"], {
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

  for (const message of messages) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  child.stdin.end();

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });

  assert.equal(exitCode, 0, stderr || stdout);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-mcp-smoke-"));
await runCommand(["init", "--repo", repoPath]);

const baseMessages = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "thehood-smoke",
        version: "0.0.0"
      }
    }
  },
  {
    jsonrpc: "2.0",
    method: "notifications/initialized"
  }
];

const happyPath = await runMcp([
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
      name: "thehood_plan",
      arguments: {
        goal: "map mcp smoke",
        repo_path: repoPath
      }
    }
  }
]);

assert.equal(happyPath[0].result.protocolVersion, "2025-06-18");
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_plan"),
  "tools/list should expose thehood_plan"
);
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_consult"),
  "tools/list should expose thehood_consult"
);
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_doctor"),
  "tools/list should expose thehood_doctor"
);
assert.equal(happyPath[2].result.structuredContent.status, "created");
assert.equal(happyPath[2].result.structuredContent.mode, "plan");

const doctorPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_doctor",
      arguments: {
        repo_path: repoPath
      }
    }
  }
]);

const doctorContent = doctorPath[1].result.structuredContent;
const stubProvider = doctorContent.providers.find((provider) => provider.id === "stub");
assert.equal(stubProvider.implemented, true);
assert.deepEqual(stubProvider.issues, []);

const assignRolesPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_assign_roles",
      arguments: {
        repo_path: repoPath,
        role_mapping: {
          planner: "stub:planner",
          researcher: "stub:researcher"
        }
      }
    }
  }
]);

assert.equal(assignRolesPath[1].result.structuredContent.roles.planner, "stub:planner");
assert.equal(assignRolesPath[1].result.structuredContent.roles.researcher, "stub:researcher");

const consultPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_consult",
      arguments: {
        goal: "ask a guest critic for mcp smoke",
        repo_path: repoPath,
        role: "critic",
        agent: "stub:critic"
      }
    }
  }
]);

assert.equal(consultPath[1].result.structuredContent.status, "completed");
assert.equal(consultPath[1].result.structuredContent.consulted_role, "critic");
assert.equal(consultPath[1].result.structuredContent.roles.critic, "stub:critic");
assert.equal(consultPath[1].result.structuredContent.provider_response_count, 1);
assert.equal(
  consultPath[1].result.structuredContent.provider_responses[0].data.critiqueResult.verdict,
  "acceptable"
);

const consultAgentArtifact = consultPath[1].result.structuredContent.artifacts.find(
  (artifact) => artifact.kind === "agent"
);
assert.ok(consultAgentArtifact, "consult should expose agent response artifact");

const artifactPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_read_artifact",
      arguments: {
        run_id: consultPath[1].result.structuredContent.run_id,
        repo_path: repoPath,
        ref: consultAgentArtifact.ref,
        max_bytes: 4096
      }
    }
  }
]);

assert.equal(artifactPath[1].result.structuredContent.artifact.kind, "agent");
assert.equal(artifactPath[1].result.structuredContent.truncated, false);
assert.ok(artifactPath[1].result.structuredContent.content.includes("critiqueResult"));

const fakeAgentPath = path.join(repoPath, "fake-agent.mjs");
await fs.writeFile(
  fakeAgentPath,
  [
    "#!/usr/bin/env node",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({",
    "    status: 'ok',",
    "    summary: input.includes('Runtime directive') ? 'fake guest saw directive' : 'fake guest missing directive',",
    "    data: {",
    "      critiqueResult: {",
    "        verdict: 'acceptable',",
    "        blockingConcerns: [],",
    "        nonBlockingConcerns: ['fake local command adapter path exercised']",
    "      }",
    "    }",
    "  }));",
    "});",
    ""
  ].join("\n"),
  "utf8"
);
await fs.chmod(fakeAgentPath, 0o755);
process.env.THEHOOD_CLAUDE_COMMAND = fakeAgentPath;

const fakeClaudeConsultGate = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_consult",
      arguments: {
        goal: "ask fake claude through local command adapter",
        repo_path: repoPath,
        role: "critic",
        agent: "claude-code:default"
      }
    }
  }
]);

const fakeClaudeRunId = fakeClaudeConsultGate[1].result.structuredContent.run_id;
const fakeClaudeNextApproval = fakeClaudeConsultGate[1].result.structuredContent.next_actions.find(
  (action) => action.action === "continue_with_approval"
);
assert.equal(fakeClaudeConsultGate[1].result.structuredContent.status, "awaiting_approval");
assert.equal(fakeClaudeConsultGate[1].result.structuredContent.consulted_agent, "claude-code:default");
assert.equal(fakeClaudeNextApproval.tool, "thehood_continue");
assert.equal(fakeClaudeNextApproval.arguments.run_id, fakeClaudeRunId);
assert.equal(fakeClaudeNextApproval.arguments.approval, "approve");
assert.ok(fakeClaudeNextApproval.arguments.message.includes("invoke claude-code"));
assert.equal(
  fakeClaudeConsultGate[1].result.structuredContent.provider_responses[0].data.critiqueResult.verdict,
  "unclear"
);

const fakeClaudeConsultPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_continue",
      arguments: {
        run_id: fakeClaudeRunId,
        repo_path: repoPath,
        approval: "approve",
        message: "I approve invoke claude-code for MCP smoke."
      }
    }
  }
]);

assert.equal(fakeClaudeConsultPath[1].result.structuredContent.status, "completed");
assert.equal(fakeClaudeConsultPath[1].result.structuredContent.provider_responses[0].summary, "fake guest saw directive");
assert.equal(
  fakeClaudeConsultPath[1].result.structuredContent.provider_responses[0].data.critiqueResult.verdict,
  "acceptable"
);

const fakeChatGptPath = path.join(repoPath, "fake-chatgpt-web.mjs");
await fs.writeFile(
  fakeChatGptPath,
  [
    "#!/usr/bin/env node",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({",
    "    status: 'ok',",
    "    summary: input.includes('Runtime directive') ? 'fake chatgpt saw directive' : 'fake chatgpt missing directive',",
    "    data: {",
    "      decision: {",
    "        action: 'complete',",
    "        reason: 'fake ChatGPT Web bridge path exercised'",
    "      }",
    "    }",
    "  }));",
    "});",
    ""
  ].join("\n"),
  "utf8"
);
await fs.chmod(fakeChatGptPath, 0o755);
process.env.THEHOOD_CHATGPT_WEB_COMMAND = fakeChatGptPath;

const fakeChatGptConsultGate = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_consult",
      arguments: {
        goal: "ask fake ChatGPT Pro through web bridge",
        repo_path: repoPath,
        role: "orchestrator",
        agent: "chatgpt-web:chatgpt-pro"
      }
    }
  }
]);

const fakeChatGptRunId = fakeChatGptConsultGate[1].result.structuredContent.run_id;
const fakeChatGptNextApproval = fakeChatGptConsultGate[1].result.structuredContent.next_actions.find(
  (action) => action.action === "continue_with_approval"
);
assert.equal(fakeChatGptConsultGate[1].result.structuredContent.status, "awaiting_approval");
assert.equal(fakeChatGptConsultGate[1].result.structuredContent.consulted_agent, "chatgpt-web:chatgpt-pro");
assert.equal(fakeChatGptNextApproval.tool, "thehood_continue");
assert.equal(fakeChatGptNextApproval.arguments.run_id, fakeChatGptRunId);
assert.equal(fakeChatGptNextApproval.arguments.approval, "approve");
assert.ok(fakeChatGptNextApproval.arguments.message.includes("invoke chatgpt-web"));
assert.equal(
  fakeChatGptConsultGate[1].result.structuredContent.provider_responses[0].data.decision.action,
  "request_approval"
);

const fakeChatGptConsultPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_continue",
      arguments: {
        run_id: fakeChatGptRunId,
        repo_path: repoPath,
        approval: "approve",
        message: "I approve invoke chatgpt-web for MCP smoke."
      }
    }
  }
]);

assert.equal(fakeChatGptConsultPath[1].result.structuredContent.status, "completed");
assert.equal(fakeChatGptConsultPath[1].result.structuredContent.provider_responses[0].summary, "fake chatgpt saw directive");
assert.equal(
  fakeChatGptConsultPath[1].result.structuredContent.provider_responses[0].data.decision.action,
  "complete"
);

const isolatedRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-mcp-isolated-"));
await runRawCommand("git", ["init"], isolatedRepoPath);
await fs.writeFile(path.join(isolatedRepoPath, "README.md"), "# Isolated Smoke\n", "utf8");
await runRawCommand("git", ["add", "README.md"], isolatedRepoPath);
await runRawCommand(
  "git",
  [
    "-c",
    "user.name=TheHood Smoke",
    "-c",
    "user.email=smoke@example.invalid",
    "commit",
    "-m",
    "initial"
  ],
  isolatedRepoPath
);
await runCommand(["init", "--repo", isolatedRepoPath]);

const fakeCodexDir = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-fake-codex-"));
const fakeCodexPath = path.join(fakeCodexDir, "fake-codex.mjs");
await fs.writeFile(
  fakeCodexPath,
  [
    "#!/usr/bin/env node",
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "const cdIndex = process.argv.indexOf('--cd');",
    "const workspace = cdIndex >= 0 ? process.argv[cdIndex + 1] : process.cwd();",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', async () => {",
    "  await fs.writeFile(path.join(workspace, 'implemented.txt'), 'isolated implementation\\n', 'utf8');",
    "  process.stdout.write(JSON.stringify({",
    "    status: 'ok',",
    "    summary: input.includes('Runtime directive') ? 'fake codex changed isolated workspace' : 'fake codex missing directive',",
    "    data: {",
    "      implementationResult: {",
    "        status: 'changed',",
    "        changedFiles: ['implemented.txt'],",
    "        commandsRun: [],",
    "        unresolvedRisks: []",
    "      }",
    "    }",
    "  }));",
    "});",
    ""
  ].join("\n"),
  "utf8"
);
await fs.chmod(fakeCodexPath, 0o755);
process.env.THEHOOD_CODEX_COMMAND = fakeCodexPath;
delete process.env.THEHOOD_ALLOW_DIRECT_EDIT;

const isolatedCreate = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_orchestrate",
      arguments: {
        goal: "exercise isolated codex implementer",
        repo_path: isolatedRepoPath,
        mode: "implement",
        role_mapping: {
          orchestrator: "stub:orchestrator",
          implementer: "codex-cli:default",
          verifier: "stub:verifier",
          critic: "stub:critic"
        }
      }
    }
  }
]);
const isolatedRunId = isolatedCreate[1].result.structuredContent.run_id;
const isolatedNextApproval = isolatedCreate[1].result.structuredContent.next_actions.find(
  (action) => action.action === "continue_with_approval"
);
assert.equal(isolatedNextApproval.tool, "thehood_continue");
assert.equal(isolatedNextApproval.arguments.run_id, isolatedRunId);
assert.equal(isolatedNextApproval.arguments.approval, "approve");
assert.ok(isolatedNextApproval.arguments.message.includes("starting implementation"));
const isolatedContinue = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_continue",
      arguments: {
        run_id: isolatedRunId,
        repo_path: isolatedRepoPath,
        approval: "approve",
        message: "mcp-smoke-isolated-approve"
      }
    }
  }
]);
const isolatedPatchGate = isolatedContinue[1].result.structuredContent;
const isolatedImplementation = isolatedPatchGate.provider_responses.find(
  (response) => response.data.implementationResult
).data.implementationResult;
const isolatedDiffArtifact = isolatedPatchGate.artifacts.find((artifact) => artifact.kind === "diff");
const isolatedPatchApproval = isolatedPatchGate.next_actions.find(
  (action) => action.action === "continue_with_approval"
);
const isolatedPatchInspection = isolatedPatchGate.next_actions.find(
  (action) => action.action === "inspect_artifact" && action.artifact?.ref === isolatedDiffArtifact.ref
);

assert.equal(isolatedCreate[1].result.structuredContent.status, "awaiting_approval");
assert.equal(isolatedPatchGate.status, "awaiting_approval");
assert.equal(isolatedPatchGate.approval_required, true);
assert.ok(isolatedPatchGate.approval_reason.includes("apply isolated patch"));
assert.equal(isolatedImplementation.status, "changed");
assert.equal(isolatedImplementation.isolatedWorkspace.mode, "isolated_git_worktree");
assert.equal(isolatedImplementation.patchArtifact.ref, isolatedDiffArtifact.ref);
assert.equal(isolatedPatchInspection.tool, "thehood_read_artifact");
assert.equal(isolatedPatchInspection.arguments.ref, isolatedDiffArtifact.ref);
assert.equal(isolatedPatchApproval.arguments.run_id, isolatedRunId);
assert.ok(isolatedPatchApproval.arguments.message.includes("apply isolated patch"));
await assert.rejects(fs.access(path.join(isolatedRepoPath, "implemented.txt")));

const isolatedPatch = await fs.readFile(isolatedDiffArtifact.ref, "utf8");
assert.ok(isolatedPatch.includes("implemented.txt"));
assert.ok(isolatedPatch.includes("isolated implementation"));

const isolatedApply = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_continue",
      arguments: {
        run_id: isolatedRunId,
        repo_path: isolatedRepoPath,
        approval: "approve",
        message: isolatedPatchApproval.arguments.message
      }
    }
  }
]);
const isolatedResult = isolatedApply[1].result.structuredContent;
const isolatedIntegrationReportArtifact = isolatedResult.artifacts.find(
  (artifact) => artifact.kind === "report" && artifact.summary.includes("Integration report")
);

assert.equal(isolatedResult.status, "completed");
assert.equal(isolatedResult.provider_responses.at(-1).data.verificationResult.verdict, "approve");
assert.equal(await fs.readFile(path.join(isolatedRepoPath, "implemented.txt"), "utf8"), "isolated implementation\n");
assert.ok(isolatedIntegrationReportArtifact, "isolated patch integration report should be attached");

const isolatedIntegrationReportRead = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_read_artifact",
      arguments: {
        run_id: isolatedRunId,
        repo_path: isolatedRepoPath,
        ref: isolatedIntegrationReportArtifact.ref,
        max_bytes: 10000
      }
    }
  }
]);
const isolatedIntegrationReport = JSON.parse(isolatedIntegrationReportRead[1].result.structuredContent.content);
assert.equal(isolatedIntegrationReport.applyExitCode, 0);
assert.deepEqual(isolatedIntegrationReport.changedPaths, ["implemented.txt"]);
assert.equal(isolatedIntegrationReport.protectedChangeCount, 0);
assert.equal(isolatedIntegrationReport.sourceArtifactRef, isolatedDiffArtifact.ref);
assert.ok(isolatedIntegrationReport.approvedPatchArtifactRef.endsWith(".patch"));

const protectedRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-mcp-protected-"));
await runRawCommand("git", ["init"], protectedRepoPath);
await fs.writeFile(path.join(protectedRepoPath, "README.md"), "# Protected Smoke\n", "utf8");
await runRawCommand("git", ["add", "README.md"], protectedRepoPath);
await runRawCommand(
  "git",
  [
    "-c",
    "user.name=TheHood Smoke",
    "-c",
    "user.email=smoke@example.invalid",
    "commit",
    "-m",
    "initial"
  ],
  protectedRepoPath
);
await runCommand(["init", "--repo", protectedRepoPath]);

const fakeProtectedCodexPath = path.join(fakeCodexDir, "fake-protected-codex.mjs");
await fs.writeFile(
  fakeProtectedCodexPath,
  [
    "#!/usr/bin/env node",
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "const cdIndex = process.argv.indexOf('--cd');",
    "const workspace = cdIndex >= 0 ? process.argv[cdIndex + 1] : process.cwd();",
    "process.stdin.resume();",
    "process.stdin.on('end', async () => {",
    "  await fs.mkdir(path.join(workspace, 'tests'), { recursive: true });",
    "  await fs.writeFile(path.join(workspace, 'tests', 'generated.test.ts'), 'expect(true).toBe(true);\\n', 'utf8');",
    "  process.stdout.write(JSON.stringify({",
    "    status: 'ok',",
    "    summary: 'fake codex changed protected test path',",
    "    data: {",
    "      implementationResult: {",
    "        status: 'changed',",
    "        changedFiles: ['tests/generated.test.ts'],",
    "        commandsRun: [],",
    "        unresolvedRisks: []",
    "      }",
    "    }",
    "  }));",
    "});",
    ""
  ].join("\n"),
  "utf8"
);
await fs.chmod(fakeProtectedCodexPath, 0o755);
process.env.THEHOOD_CODEX_COMMAND = fakeProtectedCodexPath;

const protectedCreate = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_orchestrate",
      arguments: {
        goal: "exercise protected isolated patch gate",
        repo_path: protectedRepoPath,
        mode: "implement",
        role_mapping: {
          orchestrator: "stub:orchestrator",
          implementer: "codex-cli:default",
          verifier: "stub:verifier",
          critic: "stub:critic"
        }
      }
    }
  }
]);
const protectedRunId = protectedCreate[1].result.structuredContent.run_id;
const protectedImplementationGate = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_continue",
      arguments: {
        run_id: protectedRunId,
        repo_path: protectedRepoPath,
        approval: "approve",
        message: "mcp-smoke-protected-approve"
      }
    }
  }
]);
const protectedPatchGate = protectedImplementationGate[1].result.structuredContent;
const protectedPatchApproval = protectedPatchGate.next_actions.find(
  (action) => action.action === "continue_with_approval"
);
assert.equal(protectedPatchGate.status, "awaiting_approval");
assert.ok(protectedPatchGate.approval_reason.includes("apply isolated patch"));
assert.ok(protectedPatchApproval.arguments.message.includes("apply isolated patch"));

const protectedApply = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_continue",
      arguments: {
        run_id: protectedRunId,
        repo_path: protectedRepoPath,
        approval: "approve",
        message: protectedPatchApproval.arguments.message
      }
    }
  }
]);
const protectedResult = protectedApply[1].result.structuredContent;
const protectedIntegrationReportArtifact = protectedResult.artifacts.find(
  (artifact) => artifact.kind === "report" && artifact.summary.includes("Integration report")
);
const protectedChangeApproval = protectedResult.next_actions.find(
  (action) => action.action === "continue_with_approval"
);
assert.equal(protectedResult.status, "awaiting_approval");
assert.equal(protectedResult.approval_required, true);
assert.ok(protectedResult.approval_reason.includes("protected test changes"));
assert.ok(protectedChangeApproval.arguments.message.includes("protected test changes"));
assert.equal(
  await fs.readFile(path.join(protectedRepoPath, "tests", "generated.test.ts"), "utf8"),
  "expect(true).toBe(true);\n"
);
assert.ok(protectedIntegrationReportArtifact, "protected patch integration report should be attached");
const protectedReportInspection = protectedResult.next_actions.find(
  (action) => action.action === "inspect_artifact" && action.artifact?.ref === protectedIntegrationReportArtifact.ref
);
assert.equal(protectedReportInspection.tool, "thehood_read_artifact");
assert.equal(protectedReportInspection.arguments.ref, protectedIntegrationReportArtifact.ref);

const protectedIntegrationReportRead = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_read_artifact",
      arguments: {
        run_id: protectedRunId,
        repo_path: protectedRepoPath,
        ref: protectedIntegrationReportArtifact.ref,
        max_bytes: 10000
      }
    }
  }
]);
const protectedIntegrationReport = JSON.parse(protectedIntegrationReportRead[1].result.structuredContent.content);
assert.equal(protectedIntegrationReport.protectedChangeCount, 1);
assert.deepEqual(protectedIntegrationReport.protectedChanges, [
  {
    path: "tests/generated.test.ts",
    pattern: "**/tests/**"
  }
]);

const protectedVerification = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_continue",
      arguments: {
        run_id: protectedRunId,
        repo_path: protectedRepoPath,
        approval: "approve",
        message: protectedChangeApproval.arguments.message
      }
    }
  }
]);
const protectedVerificationResult = protectedVerification[1].result.structuredContent;
assert.equal(protectedVerificationResult.status, "awaiting_approval");
assert.equal(protectedVerificationResult.provider_responses.at(-1).data.verificationResult.verdict, "ask_user");
assert.ok(protectedVerificationResult.approval_reason.includes("Verifier returned ask_user"));

const runsPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_runs",
      arguments: {
        repo_path: repoPath,
        limit: 10
      }
    }
  }
]);

assert.ok(
  runsPath[1].result.structuredContent.runs.some(
    (run) => run.run_id === fakeClaudeConsultPath[1].result.structuredContent.run_id
  ),
  "runs should include the fake Claude consult run"
);

const invariantPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_orchestrate",
      arguments: {
        goal: "bad invariant",
        repo_path: repoPath,
        role_mapping: {
          implementer: "codex-cli:default",
          verifier: "codex-cli:default"
        }
      }
    }
  }
]);

assert.equal(invariantPath[1].result.isError, true);
assert.equal(invariantPath[1].result.structuredContent.error.code, "permission_denied");

const loopRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-mcp-loop-smoke-"));
await runCommand(["init", "--repo", loopRepoPath]);

const loopCreate = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_orchestrate",
      arguments: {
        goal: "mcp deterministic loop",
        repo_path: loopRepoPath,
        mode: "implement",
        role_mapping: {
          orchestrator: "stub:orchestrator",
          implementer: "stub:implementer",
          verifier: "stub:verifier",
          critic: "stub:critic"
        }
      }
    }
  }
]);

const loopRunId = loopCreate[1].result.structuredContent.run_id;
const loopContinue = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_continue",
      arguments: {
        run_id: loopRunId,
        repo_path: loopRepoPath,
        approval: "approve",
        message: "mcp-smoke-approved"
      }
    }
  }
]);

assert.equal(loopCreate[1].result.structuredContent.status, "awaiting_approval");
assert.equal(loopContinue[1].result.structuredContent.status, "completed");
assert.equal(loopContinue[1].result.structuredContent.provider_response_count, 3);
assert.equal(loopContinue[1].result.structuredContent.provider_responses.at(-1).data.verificationResult.verdict, "approve");

process.stdout.write(`MCP smoke passed using ${repoPath}\n`);
