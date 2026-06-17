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
assert.equal(happyPath[2].result.structuredContent.status, "created");
assert.equal(happyPath[2].result.structuredContent.mode, "plan");

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

process.stdout.write(`MCP smoke passed using ${repoPath}\n`);
