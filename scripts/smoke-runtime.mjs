import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cliPath = path.join(root, "dist", "cli", "main.js");
const chatGptBridgePath = path.join(root, "dist", "bridges", "chatgptWebBridge.js");
const baseEnv = () => ({
  ...process.env,
  THEHOOD_CHATGPT_WEB_COMMAND: "",
  THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED: "0",
  THEHOOD_CHATGPT_WEB_ALLOW_UNVERIFIED_MODEL: "0",
  THEHOOD_CHATGPT_WEB_CDP_URL: "http://127.0.0.1:9"
});
const { chooseRepoContextRoute, parseGitHubRemoteUrl } = await import(
  pathToFileURL(path.join(root, "dist", "runtime", "remoteRepoContext.js")).href
);
const { decideReviewRouting } = await import(
  pathToFileURL(path.join(root, "dist", "runtime", "reviewRouting.js")).href
);
const { classifyChatGptPageSnapshot } = await import(
  pathToFileURL(path.join(root, "dist", "runtime", "chatGptPageReadiness.js")).href
);

const encodeWebSocketText = (value) => {
  const payload = Buffer.from(value);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }

  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
};

const decodeWebSocketTextFrames = (buffer) => {
  const messages = [];
  let closeReceived = false;
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const frameStart = offset;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    offset += 2;

    let length = second & 0x7f;
    if (length === 126) {
      if (offset + 2 > buffer.length) {
        return { messages, closeReceived, remaining: buffer.subarray(frameStart) };
      }
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.length) {
        return { messages, closeReceived, remaining: buffer.subarray(frameStart) };
      }
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    const masked = Boolean(second & 0x80);
    if (masked && offset + 4 > buffer.length) {
      return { messages, closeReceived, remaining: buffer.subarray(frameStart) };
    }

    const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
    offset += masked ? 4 : 0;

    if (offset + length > buffer.length) {
      return { messages, closeReceived, remaining: buffer.subarray(frameStart) };
    }

    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    offset += length;

    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    const opcode = first & 0x0f;
    if (opcode === 1) {
      messages.push(payload.toString("utf8"));
    } else if (opcode === 8) {
      closeReceived = true;
    }
  }

  return { messages, closeReceived, remaining: buffer.subarray(offset) };
};

const createCdpSmokeServer = (snapshot) => {
  const server = http.createServer((request, response) => {
    if (request.url === "/json/list") {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify([
        {
          url: snapshot.url,
          title: snapshot.title ?? "ChatGPT",
          webSocketDebuggerUrl: `ws://${request.headers.host}/devtools/page/smoke`
        }
      ]));
      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n"));

    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const decoded = decodeWebSocketTextFrames(buffered);
      buffered = decoded.remaining;
      if (decoded.closeReceived) {
        socket.end();
        return;
      }

      for (const message of decoded.messages) {
        const requestMessage = JSON.parse(message);
        const result = requestMessage.method === "Runtime.evaluate"
          ? { result: { value: snapshot } }
          : {};
        socket.write(encodeWebSocketText(JSON.stringify({
          id: requestMessage.id,
          result
        })));
      }
    });
  });

  return server;
};

const createBridgeLifecycleCdpServer = (assistantResponses) => {
  const targetId = "thehood-bridge-smoke-target";
  let targetCreated = false;
  let promptCount = 0;
  let createCount = 0;
  let closeCount = 0;

  const valueForExpression = (expression) => {
    if (expression.includes("composerPresent") && expression.includes("location.href")) {
      return {
        url: "https://chatgpt.com/",
        title: "ChatGPT",
        authSignal: null,
        composerPresent: true
      };
    }

    if (expression.includes("return promptSelectors.some")) {
      return true;
    }

    if (expression.includes("querySelectorAll") && expression.includes("textContent")) {
      return assistantResponses.slice(0, promptCount);
    }

    if (expression.includes("editor.focus") && expression.includes("sendSelectors")) {
      promptCount = Math.min(promptCount + 1, assistantResponses.length);
      return {
        ok: true,
        method: "button"
      };
    }

    if (expression.includes("Message delivery timed out")) {
      return null;
    }

    return null;
  };

  const server = http.createServer((request, response) => {
    if (request.url === "/json/list") {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(targetCreated
        ? [
            {
              id: targetId,
              url: "https://chatgpt.com/",
              title: "ChatGPT",
              webSocketDebuggerUrl: `ws://${request.headers.host}/devtools/page/${targetId}`
            }
          ]
        : []));
      return;
    }

    if (request.url?.startsWith("/json/new")) {
      targetCreated = true;
      createCount += 1;
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({
        id: targetId,
        url: "https://chatgpt.com/",
        title: "ChatGPT",
        webSocketDebuggerUrl: `ws://${request.headers.host}/devtools/page/${targetId}`
      }));
      return;
    }

    if (request.url === `/json/close/${targetId}`) {
      closeCount += 1;
      response.writeHead(200, {
        "content-type": "text/plain"
      });
      response.end("Target is closing");
      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n"));

    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const decoded = decodeWebSocketTextFrames(buffered);
      buffered = decoded.remaining;
      if (decoded.closeReceived) {
        socket.end();
        return;
      }

      for (const message of decoded.messages) {
        const requestMessage = JSON.parse(message);
        const result = requestMessage.method === "Runtime.evaluate"
          ? { result: { value: valueForExpression(requestMessage.params.expression) } }
          : {};
        socket.write(encodeWebSocketText(JSON.stringify({
          id: requestMessage.id,
          result
        })));
      }
    });
  });

  return {
    server,
    createCount: () => createCount,
    closeCount: () => closeCount
  };
};

const runCli = async (args, options = {}) => {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: root,
    env: {
      ...baseEnv(),
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
    env: {
      ...baseEnv(),
      ...(options.env ?? {})
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

const runLocalCommand = async (command, args, cwd) => {
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

  return {
    stdout,
    stderr,
    exitCode
  };
};

assert.deepEqual(parseGitHubRemoteUrl("https://github.com/owner/repo.git"), {
  owner: "owner",
  repo: "repo",
  normalizedUrl: "https://github.com/owner/repo"
});
assert.deepEqual(parseGitHubRemoteUrl("git@github.com:owner/repo.git"), {
  owner: "owner",
  repo: "repo",
  normalizedUrl: "https://github.com/owner/repo"
});
assert.deepEqual(parseGitHubRemoteUrl("ssh://git@github.com/owner/repo.git"), {
  owner: "owner",
  repo: "repo",
  normalizedUrl: "https://github.com/owner/repo"
});
assert.equal(parseGitHubRemoteUrl("https://example.com/owner/repo.git"), undefined);
assert.deepEqual(classifyChatGptPageSnapshot({
  url: "https://chatgpt.com/",
  authSignal: null,
  composerPresent: true
}), {
  authRequired: false,
  authenticated: true,
  composerReady: true,
  ready: true,
  issues: []
});
assert.deepEqual(classifyChatGptPageSnapshot({
  url: "https://chatgpt.com/",
  text: "Welcome back. Continue with Google.",
  composerPresent: false
}), {
  authRequired: true,
  authenticated: false,
  composerReady: false,
  ready: false,
  issues: ["chatgpt_auth_required"]
});
assert.equal(
  chooseRepoContextRoute({
    provider: "chatgpt-web",
    repoPath: "/tmp/repo",
    githubRemote: {
      name: "origin",
      owner: "owner",
      repo: "repo",
      url: "git@github.com:owner/repo.git",
      normalizedUrl: "https://github.com/owner/repo"
    },
    branch: "main",
    commit: "abc",
    upstream: "origin/main",
    upstreamCommit: "abc",
    clean: true,
    pushed: true,
    statusPathCount: 0,
    statusPaths: [],
    reasons: []
  }).route,
  "github_connector"
);
assert.equal(
  chooseRepoContextRoute({
    provider: "codex-cli",
    repoPath: "/tmp/repo",
    clean: true,
    pushed: true,
    statusPathCount: 0,
    statusPaths: [],
    reasons: []
  }).route,
  "local_bundle"
);

const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-runtime-smoke-"));
const fakeCodexDir = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-runtime-fake-codex-"));
const fakeCodexPath = path.join(fakeCodexDir, "fake-codex.mjs");
await fs.writeFile(
  fakeCodexPath,
  [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'debug' && args[1] === 'models') {",
    "  process.stdout.write(JSON.stringify({ models: [",
    "    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }], additional_speed_tiers: ['fast'], service_tiers: [{ id: 'priority' }] },",
    "    { slug: 'gpt-5.3-codex-spark', display_name: 'GPT-5.3-Codex-Spark', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] }",
    "  ] }));",
    "  process.exit(0);",
    "}",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  const key = input.match(/requiredDataKey\\\":\\s*\\\"([^\\\"]+)\\\"/)?.[1] ?? 'decision';",
    "  const runId = input.match(/runId\\\":\\s*\\\"([^\\\"]+)\\\"/)?.[1] ?? 'fake-run';",
    "  const nonce = input.match(/nonce\\\":\\s*\\\"([^\\\"]+)\\\"/)?.[1] ?? 'fake-nonce';",
    "  const ack = { runId, nonce, responseField: 'thehoodDirectiveAck' };",
    "  if (input.includes('SMOKE_MALFORMED_LOCAL_OUTPUT')) {",
    "    process.stdout.write(JSON.stringify({ type: 'result', result: 'not an AgentResponse envelope' }));",
    "    return;",
    "  }",
    "  const payloads = {",
    "    decision: { action: 'complete', reason: 'fake codex smoke response', evidenceRefs: ['smoke-evidence-ref'], artifactRefs: ['smoke-artifact-ref'], thehoodDirectiveAck: ack },",
    "    critiqueResult: { verdict: 'acceptable', blockingConcerns: [], nonBlockingConcerns: ['fake codex review path exercised'], thehoodDirectiveAck: ack },",
    "    verificationResult: { verdict: 'approve', summary: 'fake codex verified', failedCriteria: [], risks: [], nextAction: 'complete', thehoodDirectiveAck: ack },",
    "    qaResult: { verdict: 'pass', summary: 'fake codex QA passed', suggestedCommands: [], risks: [], thehoodDirectiveAck: ack }",
    "  };",
    "  process.stdout.write(JSON.stringify({",
    "    status: 'ok',",
    "    summary: 'fake codex smoke response',",
    "    data: { [key]: payloads[key] ?? payloads.decision }",
    "  }));",
    "});",
    ""
  ].join("\n"),
  "utf8"
);
await fs.chmod(fakeCodexPath, 0o755);
process.env.THEHOOD_CODEX_COMMAND = fakeCodexPath;
const fakeClaudeDir = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-runtime-fake-claude-"));
const fakeClaudePath = path.join(fakeClaudeDir, "fake-claude.mjs");
await fs.writeFile(
  fakeClaudePath,
  [
    "#!/usr/bin/env node",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  const key = input.match(/requiredDataKey\\\":\\s*\\\"([^\\\"]+)\\\"/)?.[1] ?? 'decision';",
    "  const runId = input.match(/runId\\\":\\s*\\\"([^\\\"]+)\\\"/)?.[1] ?? 'fake-run';",
    "  const nonce = input.match(/nonce\\\":\\s*\\\"([^\\\"]+)\\\"/)?.[1] ?? 'fake-nonce';",
    "  const ack = { runId, nonce, responseField: 'thehoodDirectiveAck' };",
    "  const payloads = {",
    "    decision: { action: 'complete', reason: 'fake claude wrapper response', evidenceRefs: ['claude-evidence-ref'], artifactRefs: ['claude-artifact-ref'], thehoodDirectiveAck: ack },",
    "    critiqueResult: { verdict: 'acceptable', blockingConcerns: [], nonBlockingConcerns: ['fake claude wrapper path exercised'], thehoodDirectiveAck: ack },",
    "    verificationResult: { verdict: 'approve', summary: 'fake claude verified', failedCriteria: [], risks: [], nextAction: 'complete', thehoodDirectiveAck: ack },",
    "    qaResult: { verdict: 'pass', summary: 'fake claude QA passed', suggestedCommands: [], risks: [], thehoodDirectiveAck: ack }",
    "  };",
    "  const response = {",
    "    status: 'ok',",
    "    summary: 'fake claude wrapper response',",
    "    data: { [key]: payloads[key] ?? payloads.decision }",
    "  };",
    "  process.stdout.write(JSON.stringify({",
    "    type: 'result',",
    "    subtype: 'success',",
    "    is_error: false,",
    "    result: 'fake claude returned a structured_output wrapper',",
    "    status: response.status,",
    "    summary: response.summary,",
    "    structured_output: { data: response.data }",
    "  }));",
    "});",
    ""
  ].join("\n"),
  "utf8"
);
await fs.chmod(fakeClaudePath, 0o755);
process.env.THEHOOD_CLAUDE_COMMAND = fakeClaudePath;
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
assert.equal(chatGptMcpConfigResult.installed.env.THEHOOD_CHATGPT_WEB_RUN_SCOPED_TARGETS, "1");
assert.equal(chatGptMcpConfigResult.installed.env.THEHOOD_CHATGPT_WEB_KEEP_TARGET_ON_FAILURE, "1");
assert.equal(chatGptMcpConfigResult.installed.startupTimeoutSec, 120);
assert.equal(chatGptMcpConfigResult.local.env.THEHOOD_CHATGPT_WEB_COMMAND, chatGptBridgePath);
assert.equal(chatGptMcpConfigResult.local.env.THEHOOD_CHATGPT_WEB_TIMEOUT_MS, "300000");
assert.equal(chatGptMcpConfigResult.local.env.THEHOOD_CHATGPT_WEB_RUN_SCOPED_TARGETS, "1");
assert.equal(chatGptMcpConfigResult.local.env.THEHOOD_CHATGPT_WEB_KEEP_TARGET_ON_FAILURE, "1");
assert.equal(chatGptMcpConfigResult.local.startupTimeoutSec, 120);
assert.ok(chatGptMcpConfigResult.localToml.includes("THEHOOD_CHATGPT_WEB_COMMAND"));
assert.ok(chatGptMcpConfigResult.localToml.includes("THEHOOD_CHATGPT_WEB_TIMEOUT_MS"));
assert.ok(chatGptMcpConfigResult.localToml.includes("THEHOOD_CHATGPT_WEB_RUN_SCOPED_TARGETS"));
assert.ok(chatGptMcpConfigResult.localToml.includes("THEHOOD_CHATGPT_WEB_KEEP_TARGET_ON_FAILURE"));
assert.ok(chatGptMcpConfigResult.localToml.includes("startup_timeout_sec = 120"));
const bridgeSmokeSchemaPath = path.join(repoPath, "chatgpt-bridge-smoke.schema.json");
await fs.writeFile(
  bridgeSmokeSchemaPath,
  `${JSON.stringify({ properties: { data: { required: ["decision"] } } }, null, 2)}\n`,
  "utf8"
);
const failedBridgeCdp = createBridgeLifecycleCdpServer(["Pro answered visibly, but not as AgentResponse JSON."]);
await new Promise((resolve) => failedBridgeCdp.server.listen(0, "127.0.0.1", resolve));
const failedBridgeAddress = failedBridgeCdp.server.address();
assert.ok(failedBridgeAddress && typeof failedBridgeAddress === "object");
try {
  const failedBridgeOutput = JSON.parse((
    await runNodeScript(
      chatGptBridgePath,
      [
        "--schema",
        bridgeSmokeSchemaPath,
        "--cdp-url",
        `http://127.0.0.1:${failedBridgeAddress.port}`,
        "--timeout-ms",
        "200"
      ],
      "bridge failure smoke",
      {
        env: {
          THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED: "1"
        }
      }
    )
  ).stdout);
  assert.equal(failedBridgeOutput.status, "blocked");
  assert.equal(failedBridgeCdp.closeCount(), 0, "failed bridge ingestion should keep the created target open");
} finally {
  await new Promise((resolve, reject) => {
    failedBridgeCdp.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(undefined);
    });
  });
}
const successfulAgentResponse = JSON.stringify({
  status: "ok",
  summary: "parsed visible AgentResponse",
  data: {
    decision: {
      action: "complete",
      reason: "bridge lifecycle smoke"
    }
  }
});
const successfulBridgeCdp = createBridgeLifecycleCdpServer([successfulAgentResponse]);
await new Promise((resolve) => successfulBridgeCdp.server.listen(0, "127.0.0.1", resolve));
const successfulBridgeAddress = successfulBridgeCdp.server.address();
assert.ok(successfulBridgeAddress && typeof successfulBridgeAddress === "object");
try {
  const successfulBridgeOutput = JSON.parse((
    await runNodeScript(
      chatGptBridgePath,
      [
        "--schema",
        bridgeSmokeSchemaPath,
        "--cdp-url",
        `http://127.0.0.1:${successfulBridgeAddress.port}`,
        "--timeout-ms",
        "5000"
      ],
      "bridge success smoke",
      {
        env: {
          THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED: "1"
        }
      }
    )
  ).stdout);
  assert.equal(successfulBridgeOutput.status, "ok");
  assert.equal(successfulBridgeCdp.closeCount(), 1, "successful bridge ingestion should close the created target");
} finally {
  await new Promise((resolve, reject) => {
    successfulBridgeCdp.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(undefined);
    });
  });
}
const runScopedBridgeSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-chatgpt-session-smoke-"));
const runScopedBridgeCdp = createBridgeLifecycleCdpServer([
  successfulAgentResponse,
  successfulAgentResponse
]);
await new Promise((resolve) => runScopedBridgeCdp.server.listen(0, "127.0.0.1", resolve));
const runScopedBridgeAddress = runScopedBridgeCdp.server.address();
assert.ok(runScopedBridgeAddress && typeof runScopedBridgeAddress === "object");
try {
  const runScopedEnv = {
    THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED: "1",
    THEHOOD_RUN_ID: "run_bridge_session_smoke",
    THEHOOD_CHATGPT_WEB_SESSION_DIR: runScopedBridgeSessionDir
  };
  const firstRunScopedBridgeOutput = JSON.parse((
    await runNodeScript(
      chatGptBridgePath,
      [
        "--schema",
        bridgeSmokeSchemaPath,
        "--cdp-url",
        `http://127.0.0.1:${runScopedBridgeAddress.port}`,
        "--timeout-ms",
        "5000"
      ],
      "bridge run-scoped target smoke first",
      { env: runScopedEnv }
    )
  ).stdout);
  const secondRunScopedBridgeOutput = JSON.parse((
    await runNodeScript(
      chatGptBridgePath,
      [
        "--schema",
        bridgeSmokeSchemaPath,
        "--cdp-url",
        `http://127.0.0.1:${runScopedBridgeAddress.port}`,
        "--timeout-ms",
        "5000"
      ],
      "bridge run-scoped target smoke second",
      { env: runScopedEnv }
    )
  ).stdout);
  assert.equal(firstRunScopedBridgeOutput.status, "ok");
  assert.equal(secondRunScopedBridgeOutput.status, "ok");
  assert.equal(runScopedBridgeCdp.createCount(), 1, "run-scoped bridge calls should reuse one ChatGPT target");
  assert.equal(runScopedBridgeCdp.closeCount(), 0, "run-scoped bridge target should stay open for follow-up calls");
} finally {
  await fs.rm(runScopedBridgeSessionDir, { recursive: true, force: true });
  await new Promise((resolve, reject) => {
    runScopedBridgeCdp.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(undefined);
    });
  });
}
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
const setupText = await runCli(["setup", "--repo", repoPath]);
assert.ok(setupText.stdout.includes("TheHood CLI Setup"));
assert.ok(setupText.stdout.includes("run this local build:"));
assert.ok(setupText.stdout.includes("temporary shell alias:"));
assert.ok(setupText.stdout.includes("node "));
assert.ok(setupText.stdout.includes("dist/cli/main.js ui --repo"));
const setupJson = JSON.parse((await runCli(["setup", "--repo", repoPath, "--json"])).stdout);
assert.equal(setupJson.commandName, "thehood");
assert.ok(setupJson.localBuildCommand.includes("dist/cli/main.js"));
assert.ok(setupJson.oneSessionAlias.startsWith("alias thehood="));
assert.ok(setupJson.localUiCommand.includes("--repo"));
await runCli(["init", "--repo", repoPath]);
const initialConfig = JSON.parse((await runCli(["config", "show", "--repo", repoPath, "--json"])).stdout);
assert.equal(initialConfig.defaults.maxIterations, 8);
assert.equal(initialConfig.defaults.fanoutMaxItems, 8);
const initialConfigText = await runCli(["config", "show", "--repo", repoPath]);
assert.ok(initialConfigText.stdout.includes("fanoutMaxItems: 8"));
const teamPresets = JSON.parse((await runCli(["teams", "--repo", repoPath, "--json"])).stdout);
assert.ok(teamPresets.presets.some((preset) => preset.id === "codex-default"));
assert.ok(teamPresets.presets.some((preset) => preset.id === "pro-orchestrator"));
assert.ok(teamPresets.presets.some((preset) => preset.id === "claude-critic"));
assert.ok(teamPresets.presets.some((preset) => preset.id === "claude-second-judge"));
assert.ok(teamPresets.presets.some((preset) => preset.id === "spark-plus-sonnet"));
assert.ok(teamPresets.presets.some((preset) => preset.id === "claude-builder"));
assert.ok(teamPresets.presets.some((preset) => preset.id === "pro-claude-high-assurance"));
const teamPresetRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-team-preset-smoke-"));
await runCli(["init", "--repo", teamPresetRepoPath]);
const appliedTeam = JSON.parse(
  (await runCli(["teams", "apply", "pro-orchestrator", "--repo", teamPresetRepoPath, "--json"])).stdout
);
assert.equal(appliedTeam.preset.id, "pro-orchestrator");
assert.equal(appliedTeam.config.roles.orchestrator.provider, "chatgpt-web");
assert.equal(appliedTeam.config.roles.orchestrator.model, "chatgpt-pro");
assert.equal(appliedTeam.config.roles.implementer.provider, "codex-cli");
const appliedTeamRoles = JSON.parse((await runCli(["roles", "--repo", teamPresetRepoPath, "--json"])).stdout);
assert.equal(appliedTeamRoles.orchestrator.provider, "chatgpt-web");
const appliedSparkSonnetTeam = JSON.parse(
  (await runCli(["teams", "apply", "spark-plus-sonnet", "--repo", teamPresetRepoPath, "--json"])).stdout
);
assert.equal(appliedSparkSonnetTeam.config.roles.implementer.provider, "codex-cli");
assert.equal(appliedSparkSonnetTeam.config.roles.implementer.model, "spark");
assert.equal(appliedSparkSonnetTeam.config.roles.verifier.provider, "claude-code");
assert.equal(appliedSparkSonnetTeam.config.roles.verifier.model, "sonnet");
assert.equal(appliedSparkSonnetTeam.config.roles.critic.provider, "claude-code");
const doctor = await runCli(["doctor", "--repo", repoPath, "--json"]);
const doctorResult = JSON.parse(doctor.stdout);
assert.equal(doctorResult.runtime.name, "thehood");
assert.ok(doctorResult.runtime.capabilities.includes("approval_artifact_next_actions"));
assert.ok(doctorResult.runtime.capabilities.includes("protected_integrated_patch_gate"));
assert.ok(doctorResult.runtime.capabilities.includes("cli_artifact_reads"));
assert.ok(doctorResult.runtime.capabilities.includes("approval_phrase_enforcement"));
assert.ok(doctorResult.runtime.capabilities.includes("final_report_artifacts"));
assert.ok(doctorResult.runtime.capabilities.includes("external_transfer_manifests"));
assert.ok(doctorResult.runtime.capabilities.includes("external_transfer_approval_policy"));
assert.ok(doctorResult.runtime.capabilities.includes("targeted_repo_context_followups"));
assert.ok(doctorResult.runtime.capabilities.includes("github_connector_repo_context"));
assert.ok(doctorResult.runtime.capabilities.includes("mcp_final_report_next_action"));
assert.ok(doctorResult.runtime.capabilities.includes("canonical_memory_rehydration"));
assert.ok(doctorResult.runtime.capabilities.includes("provider_directive_ack"));
assert.ok(doctorResult.runtime.capabilities.includes("max_iteration_enforcement"));
assert.ok(doctorResult.runtime.capabilities.includes("validation_command_capture"));
assert.ok(doctorResult.runtime.capabilities.includes("review_routing_policy"));
assert.ok(doctorResult.runtime.capabilities.includes("local_agent_execution_artifacts"));
assert.ok(doctorResult.runtime.capabilities.includes("chatgpt_browser_manager"));
assert.ok(doctorResult.runtime.capabilities.includes("chatgpt_web_bridge_fail_fast"));
assert.ok(doctorResult.runtime.capabilities.includes("chatgpt_web_session_isolation"));
assert.ok(doctorResult.runtime.capabilities.includes("chatgpt_web_auth_readiness"));
assert.ok(doctorResult.runtime.capabilities.includes("branded_tui_shell"));
assert.ok(doctorResult.runtime.capabilities.includes("approval_inbox_tui"));
assert.ok(doctorResult.runtime.capabilities.includes("operator_run_monitor"));
assert.ok(doctorResult.runtime.capabilities.includes("operator_next_actions"));
assert.ok(doctorResult.runtime.capabilities.includes("crew_lane_trail"));
assert.ok(doctorResult.runtime.capabilities.includes("runtime_loop_runner"));
assert.ok(doctorResult.runtime.capabilities.includes("autopilot_approval_policy"));
assert.ok(doctorResult.runtime.capabilities.includes("mcp_autopilot_continue_guidance"));
assert.ok(doctorResult.runtime.capabilities.includes("run_status_insights"));
assert.ok(doctorResult.runtime.capabilities.includes("compact_mcp_host_responses"));
assert.ok(doctorResult.runtime.capabilities.includes("same_run_agent_summons"));
assert.ok(doctorResult.runtime.capabilities.includes("bounded_same_run_fanout"));
assert.ok(doctorResult.runtime.capabilities.includes("runtime_team_presets"));
assert.ok(doctorResult.runtime.capabilities.includes("multi_model_team_presets"));
assert.ok(doctorResult.runtime.capabilities.includes("provider_model_passthrough"));
assert.ok(doctorResult.runtime.capabilities.includes("configurable_budget_envelopes"));
assert.ok(doctorResult.runtime.capabilities.includes("model_assisted_qa_tester"));
assert.ok(doctorResult.runtime.capabilities.includes("critic_trigger_artifacts"));
assert.ok(doctorResult.runtime.capabilities.includes("revision_packet_artifacts"));
assert.ok(doctorResult.runtime.capabilities.includes("revision_trail"));
assert.ok(doctorResult.runtime.capabilities.includes("runtime_revision_delegation"));
assert.ok(doctorResult.runtime.capabilities.includes("provider_access_modes"));
assert.ok(doctorResult.runtime.capabilities.includes("mcp_repo_gateway_tools"));
assert.ok(doctorResult.runtime.capabilities.includes("chatgpt_mcp_connector_mode"));
assert.ok(doctorResult.runtime.capabilities.includes("pro_access_preflight"));
assert.ok(doctorResult.runtime.capabilities.includes("codex_agent_board"));
assert.ok(doctorResult.runtime.capabilities.includes("codex_agent_board_artifact"));
const lowRiskRouting = decideReviewRouting({
  changedPaths: ["docs/RUNTIME_LOOP.md"],
  protectedChangeCount: 0,
  validationCommandCount: 1,
  validationFailureCount: 0,
  hasQaAssignment: true,
  hasVerifierAssignment: true,
  hasQaResponse: false,
  hasVerifierResponse: false
});
assert.equal(lowRiskRouting.riskTier, "low");
assert.equal(lowRiskRouting.action, "run_verifier");
assert.equal(lowRiskRouting.required.validation, true);
assert.equal(lowRiskRouting.required.qa, false);
assert.equal(lowRiskRouting.required.verifier, true);
assert.ok(lowRiskRouting.skippedRoles.some((role) => role.role === "qa"));
const highRiskRouting = decideReviewRouting({
  changedPaths: ["src/runtime/approvalPolicy.ts"],
  protectedChangeCount: 0,
  validationCommandCount: 1,
  validationFailureCount: 0,
  hasQaAssignment: true,
  hasVerifierAssignment: true,
  hasQaResponse: false,
  hasVerifierResponse: false
});
assert.equal(highRiskRouting.riskTier, "high");
assert.equal(highRiskRouting.action, "run_qa");
assert.equal(highRiskRouting.required.qa, true);
assert.equal(highRiskRouting.required.verifier, true);
const stubHealth = doctorResult.providers.find((provider) => provider.id === "stub");
assert.equal(stubHealth.implemented, true);
assert.deepEqual(stubHealth.issues, []);
assert.deepEqual(stubHealth.accessModes, ["agent-bridge"]);
const chatGptHealth = doctorResult.providers.find((provider) => provider.id === "chatgpt-web");
assert.ok(chatGptHealth.accessModes.includes("agent-bridge"));
assert.ok(chatGptHealth.accessModes.includes("mcp-connector"));
assert.equal(chatGptHealth.modelPolicy, "passthrough");
const codexHealth = doctorResult.providers.find((provider) => provider.id === "codex-cli");
assert.equal(codexHealth.modelPolicy, "discovered");
assert.equal(codexHealth.modelDiscovery.status, "available");
assert.ok(codexHealth.models.includes("gpt-5.5"));
assert.ok(codexHealth.models.includes("gpt-5.3-codex-spark"));
const claudeHealth = doctorResult.providers.find((provider) => provider.id === "claude-code");
assert.equal(claudeHealth.modelPolicy, "passthrough");
assert.ok(claudeHealth.models.includes("sonnet"));
assert.ok(claudeHealth.models.includes("mythos"));
const modelsResult = JSON.parse((await runCli(["models", "--repo", repoPath, "--json"])).stdout);
const codexModelsProvider = modelsResult.find((provider) => provider.id === "codex-cli");
assert.equal(codexModelsProvider.modelDiscovery.status, "available");
assert.ok(codexModelsProvider.models.includes("gpt-5.5"));
assert.ok(codexModelsProvider.models.includes("gpt-5.3-codex-spark"));
const claudeModelsProvider = modelsResult.find((provider) => provider.id === "claude-code");
assert.equal(claudeModelsProvider.modelPolicy, "passthrough");
assert.ok(claudeModelsProvider.models.includes("fable"));
assert.ok(claudeModelsProvider.models.includes("sonnet"));
const defaultOrchestratorHealth = doctorResult.roles.find((role) => role.role === "orchestrator");
assert.equal(defaultOrchestratorHealth.assignment.provider, "codex-cli");
assert.equal(defaultOrchestratorHealth.assignment.model, "default");
assert.equal(defaultOrchestratorHealth.providerImplemented, true);
assert.equal(defaultOrchestratorHealth.modelAvailable, true);
assert.equal(defaultOrchestratorHealth.modelStatus, "available");
assert.deepEqual(defaultOrchestratorHealth.issues, []);
const defaultQaHealth = doctorResult.roles.find((role) => role.role === "qa");
assert.equal(defaultQaHealth.assignment.provider, "codex-cli");
assert.equal(defaultQaHealth.assignment.model, "spark");
assert.equal(defaultQaHealth.providerImplemented, true);
assert.equal(defaultQaHealth.modelConfigured, true);
assert.equal(defaultQaHealth.modelAvailable, true);
assert.equal(defaultQaHealth.modelStatus, "available");
assert.equal(defaultQaHealth.resolvedModel, "gpt-5.3-codex-spark");
const defaultVerifierHealth = doctorResult.roles.find((role) => role.role === "verifier");
assert.equal(defaultVerifierHealth.assignment.provider, "codex-cli");
assert.equal(defaultVerifierHealth.assignment.model, "spark");
assert.equal(defaultVerifierHealth.resolvedModel, "gpt-5.3-codex-spark");
assert.deepEqual(defaultVerifierHealth.issues, []);
const defaultCriticHealth = doctorResult.roles.find((role) => role.role === "critic");
assert.equal(defaultCriticHealth.assignment.provider, "codex-cli");
assert.equal(defaultCriticHealth.assignment.model, "spark");
assert.equal(defaultCriticHealth.resolvedModel, "gpt-5.3-codex-spark");
assert.deepEqual(defaultCriticHealth.issues, []);
const rosterResult = JSON.parse((await runCli(["roster", "--repo", repoPath, "--json"])).stdout);
const roster = rosterResult.roster;
const orchestratorRoster = roster.find((item) => item.role === "orchestrator");
assert.equal(orchestratorRoster.laneLabel, "Agent 1 / Orchestrator");
assert.equal(orchestratorRoster.assignmentLabel, "codex-cli:default");
assert.equal(orchestratorRoster.assignmentSource, "product_default");
assert.equal(orchestratorRoster.state, "ready");
const implementerRoster = roster.find((item) => item.role === "implementer");
assert.equal(implementerRoster.permissions.edit, true);
assert.equal(implementerRoster.readOnly, false);
const verifierRoster = roster.find((item) => item.role === "verifier");
assert.equal(verifierRoster.permissions.edit, false);
assert.equal(verifierRoster.readOnly, true);
const plannerRoster = roster.find((item) => item.role === "planner");
assert.equal(plannerRoster.state, "unassigned");
const repoAgentBoard = JSON.parse((await runCli(["agent-board", "--repo", repoPath, "--json"])).stdout);
assert.equal(repoAgentBoard.kind, "agent_board");
assert.equal(repoAgentBoard.scope, "repo");
assert.ok(repoAgentBoard.cards.some((card) => card.role === "orchestrator" && card.assignmentLabel === "codex-cli:default"));
assert.ok(repoAgentBoard.cards.some((card) => card.role === "implementer" && card.permissions.edit === true));
assert.ok(repoAgentBoard.notes.some((note) => note.includes("display guidance only")));
const repoAgentBoardArtifact = JSON.parse((await runCli(["agent-board", "--repo", repoPath, "--artifact", "--json"])).stdout);
assert.equal(repoAgentBoardArtifact.board.kind, "agent_board");
assert.equal(repoAgentBoardArtifact.board.scope, "repo");
assert.equal(repoAgentBoardArtifact.artifact.surface, "dashboard");
assert.equal(repoAgentBoardArtifact.artifact.manifest.title, "TheHood Agent Board");
assert.ok(Array.isArray(repoAgentBoardArtifact.artifact.snapshot.datasets.agent_cards));
assert.ok(repoAgentBoardArtifact.artifact.snapshot.datasets.agent_cards.some((row) => row.role === "orchestrator"));
const localAgentRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-local-agent-execution-smoke-"));
await runCli(["init", "--repo", localAgentRepoPath]);
await runCli(["approvals", "policy", "set", "mode", "autopilot", "--repo", localAgentRepoPath]);
const localAgentRun = JSON.parse(
  (await runCli([
    "run",
    "exercise local codex execution telemetry",
    "--mode",
    "review",
    "--repo",
    localAgentRepoPath,
    "--critic",
    "codex-cli:default",
    "--json"
  ])).stdout
);
const localAgentContinue = JSON.parse(
  (await runCli(["continue", localAgentRun.runId, "--repo", localAgentRepoPath, "--json"])).stdout
);
assert.equal(localAgentContinue.run.state, "completed");
const localExecutionArtifact = localAgentContinue.run.artifacts.find(
  (artifact) => artifact.kind === "provider_invocation"
);
assert.ok(localExecutionArtifact, "local codex execution should write a provider invocation artifact");
const localExecution = JSON.parse(await fs.readFile(localExecutionArtifact.ref, "utf8"));
assert.equal(localExecution.kind, "local_agent_execution");
assert.equal(localExecution.role, "critic");
assert.equal(localExecution.provider, "codex-cli");
assert.equal(localExecution.model, "default");
assert.equal(localExecution.command, fakeCodexPath);
assert.equal(localExecution.commandMode, "read-only");
assert.equal(localExecution.workspaceMode, "target_checkout");
assert.equal(localExecution.sandbox, "read-only");
assert.equal(localExecution.exitCode, 0);
assert.equal(localExecution.timedOut, false);
assert.equal(localExecution.responseParsed, true);
assert.equal(localExecution.responseStatus, "ok");
assert.equal(typeof localExecution.stdoutRef, "string");
assert.equal(typeof localExecution.stderrRef, "string");
assert.ok(localExecution.args.includes("--output-schema"));
const localExecutionStdoutArtifact = localAgentContinue.run.artifacts.find(
  (artifact) => artifact.ref === localExecution.stdoutRef
);
const localExecutionStderrArtifact = localAgentContinue.run.artifacts.find(
  (artifact) => artifact.ref === localExecution.stderrRef
);
assert.equal(localExecutionStdoutArtifact?.kind, "log");
assert.equal(localExecutionStderrArtifact?.kind, "log");
assert.ok(
  (await fs.readFile(localExecution.stdoutRef, "utf8")).includes("fake codex smoke response"),
  "local provider stdout log should capture redacted command output"
);
assert.equal(await fs.readFile(localExecution.stderrRef, "utf8"), "");
const localAgentProgressArtifact = localAgentContinue.run.artifacts.find(
  (artifact) => artifact.kind === "progress"
);
assert.ok(localAgentProgressArtifact, "completed local agent run should write a progress packet");
const localAgentProgress = JSON.parse(await fs.readFile(localAgentProgressArtifact.ref, "utf8"));
assert.equal(localAgentProgress.latest.providerExecution.ref, localExecutionArtifact.ref);
const localAgentStatusText = await runCli(["status", localAgentRun.runId, "--repo", localAgentRepoPath]);
const localAgentStatusJson = JSON.parse(
  (await runCli(["status", localAgentRun.runId, "--repo", localAgentRepoPath, "--json"])).stdout
);
assert.equal(localAgentStatusJson.insights.latestProviderExecution.artifact.ref, localExecutionArtifact.ref);
assert.equal(localAgentStatusJson.insights.latestProviderExecution.provider, "codex-cli");
assert.equal(localAgentStatusJson.insights.latestProviderExecution.role, "critic");
assert.equal(localAgentStatusJson.insights.latestProviderExecution.stdoutRef, localExecution.stdoutRef);
assert.equal(localAgentStatusJson.insights.latestProviderExecution.stderrRef, localExecution.stderrRef);
assert.equal(
  localAgentStatusJson.insights.canonicalMemory.currentRun.artifacts.latestProviderExecution.ref,
  localExecutionArtifact.ref
);
assert.ok(localAgentStatusText.stdout.includes("local agent executions:"));
assert.ok(localAgentStatusText.stdout.includes("critic codex-cli:default"));
assert.ok(localAgentStatusText.stdout.includes("stdout="));
assert.ok(localAgentStatusText.stdout.includes("stderr="));

const claudeWrapperRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-claude-wrapper-smoke-"));
await runCli(["init", "--repo", claudeWrapperRepoPath]);
await runCli(["approvals", "policy", "set", "mode", "autopilot", "--repo", claudeWrapperRepoPath]);
const claudeWrapperRun = JSON.parse(
  (await runCli([
    "run",
    "exercise claude structured output wrapper normalization",
    "--mode",
    "review",
    "--repo",
    claudeWrapperRepoPath,
    "--critic",
    "claude-code:sonnet",
    "--json"
  ])).stdout
);
const claudeWrapperContinue = JSON.parse(
  (await runCli(["continue", claudeWrapperRun.runId, "--repo", claudeWrapperRepoPath, "--json"])).stdout
);
assert.equal(claudeWrapperContinue.run.state, "completed");
assert.equal(claudeWrapperContinue.providerResponses[0].status, "ok");
assert.equal(claudeWrapperContinue.providerResponses[0].summary, "fake claude wrapper response");
assert.equal(
  claudeWrapperContinue.providerResponses[0].data.critiqueResult.nonBlockingConcerns[0],
  "fake claude wrapper path exercised"
);
const claudeWrapperExecutionArtifact = claudeWrapperContinue.run.artifacts.find(
  (artifact) => artifact.kind === "provider_invocation"
);
assert.ok(claudeWrapperExecutionArtifact, "claude wrapper smoke should write a provider invocation artifact");
const claudeWrapperExecution = JSON.parse(await fs.readFile(claudeWrapperExecutionArtifact.ref, "utf8"));
assert.equal(claudeWrapperExecution.provider, "claude-code");
assert.equal(claudeWrapperExecution.command, fakeClaudePath);
assert.equal(claudeWrapperExecution.responseParsed, true);
assert.equal(claudeWrapperExecution.responseStatus, "ok");

const implementCompleteRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-implement-complete-smoke-"));
await runCli(["init", "--repo", implementCompleteRepoPath]);
const implementCompleteRun = JSON.parse(
  (await runCli([
    "run",
    "exercise implementation completion from orchestrator evidence",
    "--repo",
    implementCompleteRepoPath,
    "--orchestrator",
    "codex-cli:default",
    "--implementer",
    "stub:implementer",
    "--qa",
    "stub:qa",
    "--verifier",
    "stub:verifier",
    "--critic",
    "stub:critic",
    "--json"
  ])).stdout
);
assert.equal(implementCompleteRun.state, "awaiting_approval");
await runCli([
  "approve",
  implementCompleteRun.runId,
  "--repo",
  implementCompleteRepoPath,
  "--reason",
  "smoke-approved"
]);
const implementCompleteContinue = JSON.parse(
  (await runCli(["continue", implementCompleteRun.runId, "--repo", implementCompleteRepoPath, "--json"])).stdout
);
assert.equal(implementCompleteContinue.run.state, "completed");
assert.equal(implementCompleteContinue.providerResponses.length, 3);
assert.equal(implementCompleteContinue.providerResponses[0].data.decision.action, "complete");
assert.ok(
  !implementCompleteContinue.run.handoffs.some(
    (handoff) => handoff.kind === "agent_handoff" && handoff.toRole === "implementer"
  ),
  "orchestrator completion with evidence should not enter the implementer lane"
);
assert.ok(
  implementCompleteContinue.run.handoffs.some(
    (handoff) =>
      handoff.kind === "agent_handoff" &&
      handoff.fromRole === "orchestrator" &&
      handoff.toRole === "verifier"
  ),
  "orchestrator completion with evidence should hand off to verifier"
);
const implementCompleteFinalReportArtifact = implementCompleteContinue.run.artifacts.find(
  (artifact) => artifact.kind === "report" && artifact.summary.includes("Final report")
);
assert.ok(implementCompleteFinalReportArtifact, "orchestrator-completed implementation run should attach a final report");
const implementCompleteFinalReport = JSON.parse(
  await fs.readFile(implementCompleteFinalReportArtifact.ref, "utf8")
);
assert.equal(implementCompleteFinalReport.completedBy.role, "verifier");

await runCli(["roles", "set", "verifier", "codex-cli:default", "--repo", repoPath], { expectExitCode: 6 });
const staleConfigPath = path.join(repoPath, ".thehood", "config.json");
const staleConfig = JSON.parse(await fs.readFile(staleConfigPath, "utf8"));
delete staleConfig.roles.qa;
staleConfig.providers["codex-cli"].models = ["default"];
staleConfig.providers["claude-code"].models = ["default"];
staleConfig.providers.stub.models = ["orchestrator", "planner", "researcher", "implementer", "verifier", "critic"];
await fs.writeFile(staleConfigPath, `${JSON.stringify(staleConfig, null, 2)}\n`, "utf8");
const staleConfigDoctor = JSON.parse((await runCli(["doctor", "--repo", repoPath, "--json"])).stdout);
const staleCodexProvider = staleConfigDoctor.providers.find((provider) => provider.id === "codex-cli");
const staleClaudeProvider = staleConfigDoctor.providers.find((provider) => provider.id === "claude-code");
const staleStubProvider = staleConfigDoctor.providers.find((provider) => provider.id === "stub");
const staleQaHealth = staleConfigDoctor.roles.find((role) => role.role === "qa");
assert.ok(staleCodexProvider.models.includes("spark"), "stale repo config should not hide built-in codex spark model");
assert.ok(
  staleCodexProvider.models.includes("gpt-5.5"),
  "stale repo config should not hide live-discovered codex models"
);
assert.ok(
  staleCodexProvider.models.includes("configured"),
  "stale repo config should not hide built-in codex configured model passthrough"
);
assert.ok(
  staleClaudeProvider.models.includes("sonnet"),
  "stale repo config should not hide built-in Claude Sonnet alias"
);
assert.ok(
  staleClaudeProvider.models.includes("fable"),
  "stale repo config should not hide future-facing Claude Fable alias"
);
assert.ok(staleStubProvider.models.includes("qa"), "stale repo config should not hide built-in stub qa model");
assert.equal(staleQaHealth.assignment.provider, "codex-cli");
assert.equal(staleQaHealth.assignment.model, "spark");
assert.equal(staleQaHealth.modelConfigured, true);
assert.equal(staleQaHealth.modelAvailable, true);
assert.equal(staleQaHealth.resolvedModel, "gpt-5.3-codex-spark");
const codexFutureModelConfigPath = path.join(repoPath, ".thehood", "config.json");
const codexFutureModelConfig = JSON.parse(await fs.readFile(codexFutureModelConfigPath, "utf8"));
codexFutureModelConfig.roles.orchestrator = {
  provider: "codex-cli",
  model: "gpt-5.5"
};
await fs.writeFile(codexFutureModelConfigPath, `${JSON.stringify(codexFutureModelConfig, null, 2)}\n`, "utf8");
const codexFutureModelDoctor = JSON.parse((await runCli(["doctor", "--repo", repoPath, "--json"])).stdout);
const codexFutureModelOrchestrator = codexFutureModelDoctor.roles.find((role) => role.role === "orchestrator");
assert.equal(codexFutureModelOrchestrator.assignment.provider, "codex-cli");
assert.equal(codexFutureModelOrchestrator.assignment.model, "gpt-5.5");
assert.equal(codexFutureModelOrchestrator.modelConfigured, true);
assert.equal(codexFutureModelOrchestrator.modelAvailable, true);
assert.deepEqual(codexFutureModelOrchestrator.issues, []);
codexFutureModelConfig.roles.orchestrator = {
  provider: "codex-cli",
  model: "fable"
};
await fs.writeFile(codexFutureModelConfigPath, `${JSON.stringify(codexFutureModelConfig, null, 2)}\n`, "utf8");
const codexMissingModelDoctor = JSON.parse((await runCli(["doctor", "--repo", repoPath, "--json"])).stdout);
const codexMissingModelOrchestrator = codexMissingModelDoctor.roles.find((role) => role.role === "orchestrator");
assert.equal(codexMissingModelOrchestrator.modelConfigured, true);
assert.equal(codexMissingModelOrchestrator.modelAvailable, false);
assert.equal(codexMissingModelOrchestrator.modelStatus, "unavailable");
assert.ok(codexMissingModelOrchestrator.issues.includes("model_not_available:fable"));
codexFutureModelConfig.roles.critic = {
  provider: "claude-code",
  model: "fable"
};
await fs.writeFile(codexFutureModelConfigPath, `${JSON.stringify(codexFutureModelConfig, null, 2)}\n`, "utf8");
const claudeFutureModelDoctor = JSON.parse((await runCli(["doctor", "--repo", repoPath, "--json"])).stdout);
const claudeFutureModelCritic = claudeFutureModelDoctor.roles.find((role) => role.role === "critic");
assert.equal(claudeFutureModelCritic.assignment.provider, "claude-code");
assert.equal(claudeFutureModelCritic.assignment.model, "fable");
assert.equal(claudeFutureModelCritic.modelConfigured, true);
assert.equal(claudeFutureModelCritic.modelPolicy, "passthrough");
assert.equal(claudeFutureModelCritic.modelStatus, "listed");
assert.deepEqual(claudeFutureModelCritic.issues, []);
codexFutureModelConfig.roles.orchestrator = {
  provider: "codex-cli",
  model: "default"
};
codexFutureModelConfig.roles.critic = {
  provider: "codex-cli",
  model: "spark"
};
await fs.writeFile(codexFutureModelConfigPath, `${JSON.stringify(codexFutureModelConfig, null, 2)}\n`, "utf8");
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
const cdpServer = createCdpSmokeServer({
  url: "https://chatgpt.com/",
  title: "ChatGPT",
  authSignal: null,
  composerPresent: true
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
assert.equal(browserStatus.chatGptPageInspected, true);
assert.equal(browserStatus.chatGptAuthenticated, true);
assert.equal(browserStatus.chatGptComposerReady, true);
assert.equal(browserStatus.readyForBridge, true);
const dashboard = await runCli(["ui", "--repo", repoPath, "--cdp-url", `http://127.0.0.1:${cdpAddress.port}`]);
assert.ok(dashboard.stdout.includes("THEHOOD"));
assert.ok(dashboard.stdout.includes("THEHOOD COMMAND CENTER"));
assert.ok(dashboard.stdout.includes("BROWSER / REMOTE SURFACE"));
assert.ok(dashboard.stdout.includes("cdp reachable"));
assert.ok(dashboard.stdout.includes("JOB BOARD"));
const settingsOverview = await runCli(["ui", "settings", "--repo", repoPath, "--cdp-url", `http://127.0.0.1:${cdpAddress.port}`]);
assert.ok(settingsOverview.stdout.includes("THEHOOD SETTINGS COCKPIT"));
assert.ok(settingsOverview.stdout.includes("OPEN A SETTINGS PAGE"));
assert.ok(settingsOverview.stdout.includes("crew"));
assert.ok(settingsOverview.stdout.includes("./dist/cli/main.js ui settings crew"));
assert.equal(settingsOverview.stdout.includes("./dist/cli/main.js ui settings actions"), false);
assert.equal(settingsOverview.stdout.includes("Crew Role Commands"), false);
const settingsCrew = await runCli(["ui", "settings", "crew", "--repo", repoPath, "--cdp-url", `http://127.0.0.1:${cdpAddress.port}`]);
assert.ok(settingsCrew.stdout.includes("CREW ASSIGNMENTS"));
assert.ok(settingsCrew.stdout.includes("./dist/cli/main.js roles set"));
const explicitSettingsCrew = await runCli(["ui", "settings", "crew", "--repo", repoPath, "--cdp-url", `http://127.0.0.1:${cdpAddress.port}`]);
assert.ok(explicitSettingsCrew.stdout.includes("CREW ASSIGNMENTS"));
const settingsProviders = await runCli(["ui", "settings", "providers", "--repo", repoPath, "--cdp-url", `http://127.0.0.1:${cdpAddress.port}`]);
assert.ok(settingsProviders.stdout.includes("PROVIDER BAY"));
const settingsBudgets = await runCli(["ui", "settings", "budgets", "--repo", repoPath, "--cdp-url", `http://127.0.0.1:${cdpAddress.port}`]);
assert.ok(settingsBudgets.stdout.includes("max iterations"));
assert.ok(settingsBudgets.stdout.includes("fanout max items"));
assert.ok(settingsBudgets.stdout.includes("./dist/cli/main.js config set max-iterations"));
const settingsSafety = await runCli(["ui", "settings", "safety", "--repo", repoPath, "--cdp-url", `http://127.0.0.1:${cdpAddress.port}`]);
assert.ok(settingsSafety.stdout.includes("AUTOPILOT / TRANSFERS"));
assert.ok(settingsSafety.stdout.includes("external transfers"));
assert.ok(settingsSafety.stdout.includes("./dist/cli/main.js approvals policy set mode"));
const settingsBrowser = await runCli(["ui", "settings", "browser", "--repo", repoPath, "--cdp-url", `http://127.0.0.1:${cdpAddress.port}`]);
assert.ok(settingsBrowser.stdout.includes("BROWSER BRIDGE"));
assert.ok(settingsBrowser.stdout.includes("cdp reachable"));
assert.ok(settingsBrowser.stdout.includes("./dist/cli/main.js browser status"));
const settingsCommands = await runCli(["ui", "settings", "commands", "--repo", repoPath, "--cdp-url", `http://127.0.0.1:${cdpAddress.port}`]);
assert.ok(settingsCommands.stdout.includes("Source-Of-Truth Commands"));
assert.ok(settingsCommands.stdout.includes("Underlying Commands"));
assert.ok(settingsCommands.stdout.includes("Crew Role Commands"));
assert.ok(settingsCommands.stdout.includes("./dist/cli/main.js teams apply codex-default"));
const settingsAll = await runCli(["ui", "settings", "all", "--repo", repoPath, "--cdp-url", `http://127.0.0.1:${cdpAddress.port}`]);
assert.ok(settingsAll.stdout.includes("Editable In Config"));
const settingsJson = JSON.parse(
  (await runCli(["ui", "settings", "crew", "--repo", repoPath, "--cdp-url", `http://127.0.0.1:${cdpAddress.port}`, "--json"])).stdout
);
assert.equal(settingsJson.page, "crew");
const invalidSettingsPage = await runCli(["ui", "settings", "nope", "--repo", repoPath], { expectExitCode: 2 });
assert.ok(invalidSettingsPage.stderr.includes("Unknown settings page"));
const uiAliasRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-ui-settings-smoke-"));
const uiMaxIterations = JSON.parse(
  (await runCli(["ui", "set", "max-iterations", "7", "--repo", uiAliasRepoPath, "--json"])).stdout
);
assert.equal(uiMaxIterations.defaults.maxIterations, 7);
const uiFanoutMaxItems = JSON.parse(
  (await runCli(["ui", "set", "fanout-max-items", "3", "--repo", uiAliasRepoPath, "--json"])).stdout
);
assert.equal(uiFanoutMaxItems.defaults.fanoutMaxItems, 3);
const uiApprovalPolicy = JSON.parse(
  (await runCli(["ui", "set", "approval-mode", "autopilot", "--repo", uiAliasRepoPath, "--json"])).stdout
);
assert.equal(uiApprovalPolicy.mode, "autopilot");
assert.equal(uiApprovalPolicy.externalTransfers.mode, "auto_low_risk");
const uiTransferPolicy = JSON.parse(
  (await runCli(["ui", "set", "external-transfers", "manual", "--repo", uiAliasRepoPath, "--json"])).stdout
);
assert.equal(uiTransferPolicy.externalTransfers.mode, "manual");
const uiTeam = JSON.parse(
  (await runCli(["ui", "team", "codex-default", "--repo", uiAliasRepoPath, "--json"])).stdout
);
assert.equal(uiTeam.preset.id, "codex-default");
const uiRole = JSON.parse(
  (await runCli(["ui", "role", "qa", "stub:qa", "--repo", uiAliasRepoPath, "--json"])).stdout
);
assert.equal(uiRole.role, "qa");
assert.equal(uiRole.assignment.provider, "stub");
assert.equal(uiRole.assignment.model, "qa");
const invalidUiSet = await runCli(["ui", "set", "unknown", "value", "--repo", uiAliasRepoPath], { expectExitCode: 2 });
assert.ok(invalidUiSet.stderr.includes("thehood ui set approval-mode"));
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
const authCdpServer = createCdpSmokeServer({
  url: "https://chatgpt.com/",
  title: "ChatGPT",
  authSignal: "continue with google",
  composerPresent: false
});
await new Promise((resolve) => authCdpServer.listen(0, "127.0.0.1", resolve));
const authCdpAddress = authCdpServer.address();
assert.ok(authCdpAddress && typeof authCdpAddress === "object");
const authBrowserStatus = JSON.parse(
  (await runCli(["browser", "status", "--cdp-url", `http://127.0.0.1:${authCdpAddress.port}`, "--json"])).stdout
);
assert.equal(authBrowserStatus.cdpReachable, true);
assert.equal(authBrowserStatus.chatGptTabFound, true);
assert.equal(authBrowserStatus.chatGptPageInspected, true);
assert.equal(authBrowserStatus.chatGptAuthenticated, false);
assert.equal(authBrowserStatus.chatGptComposerReady, false);
assert.equal(authBrowserStatus.readyForBridge, false);
assert.deepEqual(authBrowserStatus.issues, ["chatgpt_auth_required"]);
const authDoctor = await runCli(["doctor", "--repo", repoPath, "--json"], {
  env: {
    THEHOOD_CHATGPT_WEB_COMMAND: chatGptBridgePath,
    THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED: "1",
    THEHOOD_CHATGPT_WEB_CDP_URL: `http://127.0.0.1:${authCdpAddress.port}`
  }
});
const authDoctorResult = JSON.parse(authDoctor.stdout);
const authChatGptProvider = authDoctorResult.providers.find((provider) => provider.id === "chatgpt-web");
assert.deepEqual(authChatGptProvider.issues, ["chatgpt_auth_required"]);
await new Promise((resolve, reject) => {
  authCdpServer.close((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve(undefined);
  });
});
const blockedChatGptPlan = JSON.parse(
  (
    await runCli([
      "plan",
      "block missing ChatGPT bridge",
      "--repo",
      repoPath,
      "--orchestrator",
      "chatgpt-web:chatgpt-pro",
      "--json"
    ])
  ).stdout
);
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

const summonPlan = JSON.parse(
  (
    await runCli([
      "plan",
      "summon a QA critic on the same run",
      "--repo",
      repoPath,
      "--orchestrator",
      "stub:orchestrator",
      "--json"
    ])
  ).stdout
);
const summonResult = JSON.parse(
  (
    await runCli([
      "summon",
      summonPlan.runId,
      "--repo",
      repoPath,
      "--role",
      "critic",
      "--agent",
      "stub:critic",
      "--kind",
      "qa",
      "--brief",
      "QA this planning slice without editing files.",
      "--json"
    ])
  ).stdout
);
assert.equal(summonResult.role, "critic");
assert.equal(summonResult.summonKind, "qa");
assert.equal(summonResult.providerResponses.length, 1);
assert.equal(summonResult.providerResponses[0].data.critiqueResult.verdict, "acceptable");
assert.equal(summonResult.responseArtifact.kind, "agent");
assert.ok(summonResult.run.events.some((event) => event.type === "agent_summoned"));
assert.ok(summonResult.run.events.some((event) => event.type === "summon_response"));
assert.ok(summonResult.run.events.some((event) => event.type === "summon_completed"));
assert.ok(
  summonResult.run.handoffs.some((handoff) => handoff.kind === "agent_handoff" && handoff.toRole === "critic")
);
const summonStatus = JSON.parse((await runCli(["status", summonPlan.runId, "--repo", repoPath, "--json"])).stdout);
assert.equal(summonStatus.insights.latestAgentResponse.primaryOutputKey, "critiqueResult");
const summonCriticLane = summonStatus.insights.reviewLanes.find((lane) => lane.id === "review-lane-critic");
assert.ok(summonCriticLane, "summoned critic should appear as review ownership evidence");
assert.equal(summonCriticLane.sourceKind, "summon_evidence");
assert.equal(summonCriticLane.canSatisfyRequired, false);
assert.equal(summonCriticLane.satisfiesRequired, false);
assert.equal(summonCriticLane.owner.role, "critic");
assert.equal(summonCriticLane.owner.assignment, "stub:critic");
assert.ok(summonCriticLane.sidecarEvidence.length > 0, "summon evidence should be marked as sidecar");

const fanoutPlan = JSON.parse(
  (
    await runCli([
      "plan",
      "fan out advisory QA and critic sidecars",
      "--repo",
      repoPath,
      "--orchestrator",
      "stub:orchestrator",
      "--json"
    ])
  ).stdout
);
const fanoutItems = JSON.stringify([
  {
    role: "qa",
    agent: "stub:qa",
    kind: "qa",
    brief: "QA this run as advisory sidecar evidence."
  },
  {
    role: "critic",
    agent: "stub:critic",
    kind: "critique",
    brief: "Critique this run as advisory sidecar evidence."
  }
]);
const fanoutResult = JSON.parse(
  (
    await runCli([
      "fanout",
      fanoutPlan.runId,
      "--repo",
      repoPath,
      "--items-json",
      fanoutItems,
      "--json"
    ])
  ).stdout
);
assert.equal(fanoutResult.status, "completed");
assert.equal(fanoutResult.bounds.requestedItems, 2);
assert.equal(fanoutResult.bounds.executedItems, 2);
assert.equal(fanoutResult.bounds.maxItems, 8);
assert.equal(fanoutResult.artifact.kind, "fanout");
assert.deepEqual(fanoutResult.items.map((item) => item.status), ["completed", "completed"]);
assert.equal(fanoutResult.items[0].responseArtifact.kind, "agent");
assert.equal(fanoutResult.items[1].assignment.provider, "stub");
const fanoutStatus = JSON.parse((await runCli(["status", fanoutPlan.runId, "--repo", repoPath, "--json"])).stdout);
assert.equal(fanoutStatus.insights.latestFanout.artifact.ref, fanoutResult.artifact.ref);
assert.equal(fanoutStatus.insights.latestFanout.status, "completed");
assert.equal(fanoutStatus.insights.latestFanout.executedItems, 2);
assert.equal(fanoutStatus.insights.latestFanout.canSatisfyRequiredGates, false);
assert.equal(
  fanoutStatus.insights.canonicalMemory.currentRun.artifacts.latestFanout.ref,
  fanoutResult.artifact.ref
);
const fanoutQaTesterLane = fanoutStatus.insights.reviewLanes.find((lane) => lane.id === "review-lane-qa-tester");
assert.ok(fanoutQaTesterLane, "fan-out QA item should appear as advisory tester evidence");
assert.equal(fanoutQaTesterLane.canSatisfyRequired, false);
assert.ok(
  fanoutStatus.agentBoard.cards.some((card) => card.role === "qa" && card.run?.sidecarOnly === true),
  "fan-out status should expose sidecar-only QA card metadata"
);
const fanoutCriticLane = fanoutStatus.insights.reviewLanes.find((lane) => lane.id === "review-lane-critic");
assert.ok(fanoutCriticLane, "fan-out critic item should appear as advisory critic evidence");
assert.equal(fanoutCriticLane.canSatisfyRequired, false);
const fanoutStatusText = await runCli(["status", fanoutPlan.runId, "--repo", repoPath]);
assert.ok(fanoutStatusText.stdout.includes("agent fan-out:"));
assert.ok(fanoutStatusText.stdout.includes("gates: advisory only"));
const fanoutResilienceRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-fanout-resilience-smoke-"));
await runCli(["init", "--repo", fanoutResilienceRepoPath]);
await runCli(["approvals", "policy", "set", "mode", "autopilot", "--repo", fanoutResilienceRepoPath]);
const fanoutResiliencePlan = JSON.parse(
  (
    await runCli([
      "plan",
      "fanout should continue after contained advisory failure",
      "--repo",
      fanoutResilienceRepoPath,
      "--orchestrator",
      "stub:orchestrator",
      "--json"
    ])
  ).stdout
);
const fanoutResilienceItems = JSON.stringify([
  {
    role: "critic",
    agent: "codex-cli:default",
    kind: "critique",
    brief: "SMOKE_MALFORMED_LOCAL_OUTPUT: emit malformed advisory output."
  },
  {
    role: "qa",
    agent: "stub:qa",
    kind: "qa",
    brief: "QA should still run after the contained malformed advisory response."
  }
]);
const fanoutResilienceResult = JSON.parse(
  (
    await runCli([
      "fanout",
      fanoutResiliencePlan.runId,
      "--repo",
      fanoutResilienceRepoPath,
      "--items-json",
      fanoutResilienceItems,
      "--json"
    ])
  ).stdout
);
assert.equal(fanoutResilienceResult.status, "blocked");
assert.equal(fanoutResilienceResult.bounds.requestedItems, 2);
assert.equal(fanoutResilienceResult.bounds.executedItems, 2);
assert.deepEqual(fanoutResilienceResult.items.map((item) => item.status), ["blocked", "completed"]);
assert.equal(fanoutResilienceResult.items[0].providerStatus, "blocked");
assert.equal(fanoutResilienceResult.items[1].assignment.provider, "stub");
const fanoutResilienceProviderExecution = fanoutResilienceResult.run.artifacts
  .filter((artifact) => artifact.kind === "provider_invocation")
  .at(-1);
assert.ok(
  fanoutResilienceProviderExecution,
  "fanout resilience smoke should capture the malformed local provider invocation"
);
const fanoutResilienceExecution = JSON.parse(await fs.readFile(fanoutResilienceProviderExecution.ref, "utf8"));
assert.equal(fanoutResilienceExecution.responseParsed, false);
assert.equal(fanoutResilienceExecution.responseStatus, "blocked");
const fanoutBudgetRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-fanout-budget-smoke-"));
await runCli(["init", "--repo", fanoutBudgetRepoPath]);
const fanoutBudgetConfig = JSON.parse(
  (await runCli(["config", "set", "fanout-max-items", "1", "--repo", fanoutBudgetRepoPath, "--json"])).stdout
);
assert.equal(fanoutBudgetConfig.defaults.fanoutMaxItems, 1);
await runCli(["config", "set", "fanout-max-items", "9", "--repo", fanoutBudgetRepoPath, "--json"], {
  expectExitCode: 2
});
const fanoutBudgetPlan = JSON.parse(
  (
    await runCli([
      "plan",
      "fanout budget smoke",
      "--repo",
      fanoutBudgetRepoPath,
      "--orchestrator",
      "stub:orchestrator",
      "--json"
    ])
  ).stdout
);
await runCli(
  [
    "fanout",
    fanoutBudgetPlan.runId,
    "--repo",
    fanoutBudgetRepoPath,
    "--items-json",
    fanoutItems,
    "--json"
  ],
  { expectExitCode: 2 }
);

const qaSidecarRun = JSON.parse(
  (
    await runCli([
      "run",
      "exercise QA tester sidecar ownership",
      "--repo",
      repoPath,
      "--orchestrator",
      "stub:orchestrator",
      "--implementer",
      "stub:implementer",
      "--qa",
      "stub:qa",
      "--verifier",
      "stub:verifier",
      "--json"
    ])
  ).stdout
);
const qaSummonResult = JSON.parse(
  (
    await runCli([
      "summon",
      qaSidecarRun.runId,
      "--repo",
      repoPath,
      "--role",
      "qa",
      "--agent",
      "stub:qa",
      "--brief",
      "QA this implementation slice without editing files.",
      "--json"
    ])
  ).stdout
);
assert.equal(qaSummonResult.role, "qa");
assert.equal(qaSummonResult.summonKind, "qa");
assert.equal(qaSummonResult.providerResponses[0].data.qaResult.verdict, "pass");
const qaSidecarStatus = JSON.parse((await runCli(["status", qaSidecarRun.runId, "--repo", repoPath, "--json"])).stdout);
const pendingRuntimeQaLane = qaSidecarStatus.insights.reviewLanes.find((lane) => lane.id === "review-lane-qa");
assert.ok(pendingRuntimeQaLane, "implementation run should expose a required runtime QA lane");
assert.equal(pendingRuntimeQaLane.kind, "qa");
assert.equal(pendingRuntimeQaLane.required, true);
assert.equal(pendingRuntimeQaLane.state, "pending");
assert.equal(pendingRuntimeQaLane.canSatisfyRequired, false);
assert.equal(pendingRuntimeQaLane.satisfiesRequired, false);
assert.ok(pendingRuntimeQaLane.sidecarEvidence.length > 0, "runtime QA lane should show QA sidecar evidence");
const qaTesterLane = qaSidecarStatus.insights.reviewLanes.find((lane) => lane.id === "review-lane-qa-tester");
assert.ok(qaTesterLane, "QA summon should expose a separate advisory tester lane");
assert.equal(qaTesterLane.kind, "tester");
assert.equal(qaTesterLane.role, "qa");
assert.equal(qaTesterLane.owner.assignment, "stub:qa");
assert.equal(qaTesterLane.required, false);
assert.equal(qaTesterLane.canSatisfyRequired, false);
assert.equal(qaTesterLane.satisfiesRequired, false);

await fs.writeFile(path.join(repoPath, "README.md"), "# Smoke Repo\n\nProvider milestone notes.\n", "utf8");
await fs.mkdir(path.join(repoPath, "src", "providers"), { recursive: true });
await fs.writeFile(
  path.join(repoPath, "src", "providers", "example.ts"),
  "export const provider = 'context-smoke';\n",
  "utf8"
);
await fs.mkdir(path.join(repoPath, "docs"), { recursive: true });
await fs.writeFile(
  path.join(repoPath, "docs", "MEMORY_AND_RECONCILIATION.md"),
  "# Memory And Reconciliation\n\nCanonical memory marker.\n",
  "utf8"
);
for (let index = 0; index < 30; index += 1) {
  await fs.writeFile(
    path.join(repoPath, "docs", `aa-filler-${String(index).padStart(2, "0")}.md`),
    `# Filler ${index}\n`,
    "utf8"
  );
}
await fs.writeFile(
  path.join(repoPath, "docs", "zz-source-of-truth.md"),
  `# Source Of Truth\n\nExplicitly requested context marker.\n${"requested evidence line\n".repeat(260)}`,
  "utf8"
);
const repoContextPlan = JSON.parse(
  (
    await runCli([
      "plan",
      "repo-context-smoke plan docs/zz-source-of-truth.md provider milestone",
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
assert.ok(
  repoContext.files.some(
    (file) =>
      file.path === "docs/MEMORY_AND_RECONCILIATION.md" &&
      file.excerpt.includes("Canonical memory marker")
  ),
  "static priority docs should include memory and reconciliation source-of-truth excerpts"
);
assert.ok(
  repoContext.files.some(
    (file) =>
      file.path === "docs/zz-source-of-truth.md" &&
      file.excerpt.includes("Explicitly requested context marker") &&
      file.maxBytes > repoContext.limits.maxBytesPerFile &&
      file.truncated === false
  ),
  "explicitly requested files should receive a larger budget and avoid normal-cap truncation"
);
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
const repoContextStatus = JSON.parse(
  (await runCli(["status", repoContextPlan.runId, "--repo", repoPath, "--json"])).stdout
);
assert.equal(repoContextStatus.insights.latestAgentResponse.status, "ok");
assert.equal(repoContextStatus.insights.latestAgentResponse.decision.action, "complete");
assert.equal(repoContextStatus.insights.latestAgentResponse.primaryOutputKey, "decision");
assert.equal(repoContextStatus.insights.finalReport.artifact.ref, repoContextFinalReportArtifact.ref);
assert.equal(repoContextStatus.insights.latestProgressPacket.kind, "progress");
assert.equal(repoContextStatus.insights.latestRepoContext.ref, contextArtifact.ref);
assert.equal(repoContextStatus.insights.canonicalMemory.kind, "canonical_memory");
assert.equal(repoContextStatus.insights.canonicalMemory.artifactBodyPolicy, "refs_only");
assert.equal(repoContextStatus.insights.canonicalMemory.ignoreProviderSessionContext, true);
assert.ok(Array.isArray(repoContextStatus.insights.reviewLanes));
assert.ok(Array.isArray(repoContextStatus.insights.operatorNextActions));
assert.ok(
  repoContextStatus.insights.operatorNextActions.some((nextAction) => nextAction.action === "terminal_complete"),
  "completed status should expose a terminal operator next action"
);
assert.ok(repoContextStatus.insights.handoffTimeline.length > 0);
assert.equal(repoContextStatus.insights.latestHandoff.kind, "completion");
const repoContextDirectiveArtifact = repoContextContinue.run.artifacts.find((artifact) => artifact.kind === "directive");
assert.ok(repoContextDirectiveArtifact, "provider directives should be stored as artifacts");
const repoContextDirective = JSON.parse(await fs.readFile(repoContextDirectiveArtifact.ref, "utf8"));
assert.equal(repoContextDirective.variables.canonicalMemory.kind, "canonical_memory");
assert.equal(repoContextDirective.variables.canonicalMemory.artifactBodyPolicy, "refs_only");
assert.equal(repoContextDirective.variables.canonicalMemory.ignoreProviderSessionContext, true);
  const repoContextStatusText = await runCli(["status", repoContextPlan.runId, "--repo", repoPath]);
  assert.ok(repoContextStatusText.stdout.includes("latest agent response:"));
  assert.ok(repoContextStatusText.stdout.includes("action: complete"));
  assert.ok(repoContextStatusText.stdout.includes("final report:"));
  assert.ok(repoContextStatusText.stdout.includes("canonical memory refs:"));
  assert.ok(repoContextStatusText.stdout.includes("operator next actions:"));
  assert.ok(!repoContextStatusText.stdout.includes("review lanes:"));
  assert.ok(repoContextStatusText.stdout.includes("handoff timeline:"));
  const repoContextLogsText = await runCli(["logs", repoContextPlan.runId, "--repo", repoPath]);
  assert.ok(repoContextLogsText.stdout.includes("handoffs:"));
  const repoContextProgressArtifact = repoContextContinue.run.artifacts.find(
    (artifact) => artifact.kind === "progress" && artifact.summary.includes("Progress packet")
  );
  assert.ok(repoContextProgressArtifact, "completed read-only run should attach a progress packet");
  const repoContextProgressPacket = JSON.parse(await fs.readFile(repoContextProgressArtifact.ref, "utf8"));
  assert.ok(Array.isArray(repoContextProgressPacket.operatorNextActions.items));
  assert.ok(
    repoContextProgressPacket.operatorNextActions.items.some((nextAction) => nextAction.action === "terminal_complete"),
    "progress packet should expose bounded operator next actions"
  );
  const repoContextReconcile = JSON.parse(
    (await runCli(["reconcile", repoContextPlan.runId, "--repo", repoPath, "--json"])).stdout
  );
  assert.equal(repoContextReconcile.run.state, "completed");
  assert.equal(repoContextReconcile.role, "orchestrator");
  assert.equal(repoContextReconcile.providerResponses.length, 1);
  assert.equal(repoContextReconcile.providerResponses[0].status, "ok");
  assert.equal(repoContextReconcile.progressArtifact.ref, repoContextProgressArtifact.ref);
  assert.equal(repoContextReconcile.reconciliationArtifact.kind, "reconciliation");
  const repoContextReconciledStatus = JSON.parse(
    (await runCli(["status", repoContextPlan.runId, "--repo", repoPath, "--json"])).stdout
  );
  assert.equal(repoContextReconciledStatus.insights.latestAgentResponse.artifact.kind, "reconciliation");
  assert.equal(repoContextReconciledStatus.insights.latestReconciliation.kind, "reconciliation");
  assert.equal(
    repoContextReconciledStatus.insights.canonicalMemory.currentRun.artifacts.latestReconciliation.ref,
    repoContextReconcile.reconciliationArtifact.ref
  );

  const roleDelegatePlan = JSON.parse(
    (
      await runCli([
        "plan",
        "role-delegate-smoke plan ready implementation slice",
        "--repo",
        repoPath,
        "--orchestrator",
        "stub:orchestrator",
        "--json"
      ])
    ).stdout
  );
  const roleDelegateContinue = JSON.parse(
    (await runCli(["continue", roleDelegatePlan.runId, "--repo", repoPath, "--json"])).stdout
  );
  assert.equal(roleDelegateContinue.run.state, "completed");
  assert.equal(roleDelegateContinue.providerResponses.length, 1);
  assert.equal(roleDelegateContinue.providerResponses[0].data.decision.action, "delegate");
  assert.equal(roleDelegateContinue.providerResponses[0].data.decision.delegateTo, "implementer");
  assert.equal(roleDelegateContinue.providerResponses[0].data.decision.requiresMoreEvidence, false);
  assert.ok(
    !roleDelegateContinue.run.artifacts.some((artifact) => artifact.kind === "context"),
    "ready implementer handoff should not capture repo context"
  );
  assert.ok(
    roleDelegateContinue.run.events.some(
      (event) => event.type === "run_completed" && event.data?.reason === "role_handoff_delegate"
    ),
    "ready implementer handoff should complete the plan run with explicit event metadata"
  );
  const roleDelegateFinalReportArtifact = roleDelegateContinue.run.artifacts.find(
    (artifact) => artifact.kind === "report" && artifact.summary.includes("Final report")
  );
  assert.ok(roleDelegateFinalReportArtifact, "ready implementer handoff should write a final report");
  const roleDelegateProgressArtifact = roleDelegateContinue.run.artifacts.find(
    (artifact) => artifact.kind === "progress" && artifact.summary.includes("Progress packet")
  );
  assert.ok(roleDelegateProgressArtifact, "ready implementer handoff should write a progress packet");

  const plannerDelegatePlan = JSON.parse(
    (
      await runCli([
        "plan",
        "planner-delegate-smoke plan ready roadmap pass",
        "--repo",
        repoPath,
        "--orchestrator",
        "stub:orchestrator",
        "--json"
      ])
    ).stdout
  );
  const plannerDelegateContinue = JSON.parse(
    (await runCli(["continue", plannerDelegatePlan.runId, "--repo", repoPath, "--json"])).stdout
  );
  assert.equal(plannerDelegateContinue.run.state, "awaiting_approval");
  assert.equal(plannerDelegateContinue.providerResponses.length, 1);
  assert.equal(plannerDelegateContinue.providerResponses[0].data.decision.action, "delegate");
  assert.equal(plannerDelegateContinue.providerResponses[0].data.decision.delegateTo, "planner");
  assert.equal(plannerDelegateContinue.providerResponses[0].data.decision.requiresMoreEvidence, false);
  assert.ok(plannerDelegateContinue.run.approvalReason.includes("planner role is not assigned"));
  assert.ok(
    plannerDelegateContinue.run.events.some(
      (event) => event.data?.reason === "missing_read_only_delegate_assignment"
    ),
    "ready planner handoff without a planner assignment should stop at a missing-role gate"
  );
  assert.ok(
    !plannerDelegateContinue.run.events.some(
      (event) => event.data?.reason === "repeated_repo_context_delegate"
    ),
    "ready planner handoff should not be treated as repeated repo context delegation"
  );

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
    "  const hasRemoteRepoContext = input.includes('\"remoteRepoContext\"');",
    "  const hasProgressPacket = input.includes('\"progressPacket\"');",
    "  const isTargetedContextSmoke = input.includes('targeted-follow-up-context-smoke');",
    "  const isTruncatedContextSmoke = input.includes('truncated-follow-up-context-smoke');",
    "  const hasTargetedEvidence = input.includes('Targeted follow-up context marker');",
    "  const hasFinalTargetedEvidence = input.includes('Targeted follow-up context marker 7');",
    "  const hasTruncatedInitial = input.includes('Truncated initial context marker');",
    "  const hasTruncatedContinuation = input.includes('Truncated continuation context marker');",
    "  const targetFiles = Array.from({ length: 8 }, (_, index) => `notes/targeted-evidence-${index}.md`);",
    "  const truncatedTargetFile = 'notes/truncated-context.md';",
    "  if (logPath) {",
    "    await fs.appendFile(logPath, hasProgressPacket ? 'progress\\n' : hasRemoteRepoContext ? 'remote-context\\n' : hasRepoContext ? hasTruncatedInitial && hasTruncatedContinuation ? 'truncated-combined-context\\n' : hasTruncatedContinuation ? 'truncated-continuation-context\\n' : hasTargetedEvidence ? 'targeted-context\\n' : 'context\\n' : 'no-context\\n', 'utf8');",
    "  }",
    "  process.stdout.write(JSON.stringify({",
    "    status: 'ok',",
    "    summary: hasProgressPacket ? 'fake ChatGPT reconciled progress packet' : hasRemoteRepoContext ? 'fake ChatGPT used GitHub connector repo context' : hasTruncatedInitial && hasTruncatedContinuation ? 'fake ChatGPT received combined truncated repo context' : hasFinalTargetedEvidence ? 'fake ChatGPT received final targeted repo context' : hasRepoContext && isTruncatedContextSmoke ? 'fake ChatGPT requested truncated continuation repo context' : hasRepoContext && isTargetedContextSmoke ? 'fake ChatGPT requested targeted repo context' : hasRepoContext ? 'fake ChatGPT received approved repo context' : 'fake ChatGPT requested repo context',",
    "    data: {",
    "      decision: hasProgressPacket ? {",
    "        action: 'complete',",
    "        reason: 'Approved progress packet was reconciled.'",
    "      } : hasRemoteRepoContext ? {",
    "        action: 'complete',",
    "        reason: 'GitHub connector repo context was enough for a plan.'",
    "      } : hasTruncatedInitial && hasTruncatedContinuation ? {",
    "        action: 'complete',",
    "        reason: 'Combined continuation repo context was enough for a plan.'",
    "      } : hasFinalTargetedEvidence ? {",
    "        action: 'complete',",
    "        reason: 'Targeted repo context was enough for a plan.'",
    "      } : hasRepoContext && isTruncatedContextSmoke ? {",
    "        action: 'delegate',",
    "        reason: 'Need the next chunk of the truncated file before planning.',",
    "        targetFiles: [truncatedTargetFile],",
    "        delegate: {",
    "          role: 'repo_reader',",
    "          task: `Capture follow-up repo context for ${truncatedTargetFile}.`",
    "        }",
    "      } : hasRepoContext && isTargetedContextSmoke ? {",
    "        action: 'delegate',",
    "        reason: 'Need one targeted follow-up file before planning.',",
    "        targetFiles,",
    "        delegate: {",
    "          role: 'repo_reader',",
    "          task: `Capture targeted follow-up repo context for ${targetFiles.join(', ')}.`",
    "        }",
    "      } : hasRepoContext ? {",
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
const remoteContextRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-remote-context-smoke-"));
await runCli(["init", "--repo", remoteContextRepoPath]);
await fs.writeFile(path.join(remoteContextRepoPath, "README.md"), "# Remote Context Smoke\n", "utf8");
await runLocalCommand("git", ["init"], remoteContextRepoPath);
await runLocalCommand("git", ["branch", "-M", "main"], remoteContextRepoPath);
await runLocalCommand("git", ["config", "user.name", "TheHood Smoke"], remoteContextRepoPath);
await runLocalCommand("git", ["config", "user.email", "smoke@example.invalid"], remoteContextRepoPath);
await runLocalCommand("git", ["add", "README.md"], remoteContextRepoPath);
await runLocalCommand("git", ["commit", "-m", "init"], remoteContextRepoPath);
await runLocalCommand(
  "git",
  ["remote", "add", "origin", "git@github.com:thehood/remote-context-smoke.git"],
  remoteContextRepoPath
);
await runLocalCommand("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], remoteContextRepoPath);
await runLocalCommand("git", ["branch", "--set-upstream-to=origin/main", "main"], remoteContextRepoPath);
await fs.writeFile(fakeExternalBridgeLogPath, "", "utf8");
const remoteContextPlan = JSON.parse(
  (
    await runCli(
      [
        "plan",
        "remote-github-connector-context-smoke provider milestone",
        "--repo",
        remoteContextRepoPath,
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
const remoteContextInvocationGate = JSON.parse(
  (
    await runCli(["continue", remoteContextPlan.runId, "--repo", remoteContextRepoPath, "--json"], {
      env: fakeExternalEnv
    })
  ).stdout
);
assert.equal(remoteContextInvocationGate.run.state, "awaiting_approval");
assert.ok(remoteContextInvocationGate.run.approvalReason.includes("Invoking chatgpt-web:chatgpt-pro"));
await runCli([
  "approve",
  remoteContextPlan.runId,
  "--repo",
  remoteContextRepoPath,
  "--reason",
  "I approve invoke chatgpt-web for remote context smoke."
]);
const remoteContextCompleted = JSON.parse(
  (
    await runCli(["continue", remoteContextPlan.runId, "--repo", remoteContextRepoPath, "--json"], {
      env: fakeExternalEnv
    })
  ).stdout
);
assert.equal(remoteContextCompleted.run.state, "completed");
assert.deepEqual(remoteContextCompleted.providerResponses.map((response) => response.data.decision.action), [
  "delegate",
  "complete"
]);
assert.deepEqual((await fs.readFile(fakeExternalBridgeLogPath, "utf8")).trim().split("\n"), [
  "no-context",
  "remote-context"
]);
const remoteContextArtifact = remoteContextCompleted.run.artifacts.find((artifact) => artifact.kind === "remote_context");
assert.ok(remoteContextArtifact, "clean pushed GitHub repo should attach a refs-only remote context artifact");
assert.ok(
  !remoteContextCompleted.run.artifacts.some((artifact) => artifact.kind === "context"),
  "clean pushed GitHub repo should not capture local context excerpts for ChatGPT Web"
);
assert.ok(
  !remoteContextCompleted.run.artifacts.some((artifact) => artifact.kind === "transfer_manifest"),
  "refs-only GitHub connector context should not create a local repo-context transfer manifest"
);
const remoteContext = JSON.parse(await fs.readFile(remoteContextArtifact.ref, "utf8"));
assert.equal(remoteContext.kind, "github_connector_repo_context");
assert.equal(remoteContext.remote.owner, "thehood");
assert.equal(remoteContext.remote.repo, "remote-context-smoke");
assert.equal(remoteContext.remote.branch, "main");
assert.equal(remoteContext.localState.clean, true);
assert.equal(remoteContext.localState.pushed, true);
const remoteContextStatus = JSON.parse(
  (await runCli(["status", remoteContextPlan.runId, "--repo", remoteContextRepoPath, "--json"])).stdout
);
assert.equal(remoteContextStatus.insights.latestRemoteRepoContext.ref, remoteContextArtifact.ref);
assert.equal(
  remoteContextStatus.insights.canonicalMemory.currentRun.artifacts.latestRemoteRepoContext.ref,
  remoteContextArtifact.ref
);
const remoteContextStatusText = await runCli(["status", remoteContextPlan.runId, "--repo", remoteContextRepoPath]);
assert.ok(remoteContextStatusText.stdout.includes("remoteRepoContext:"));
const remoteDirectiveArtifacts = remoteContextCompleted.run.artifacts.filter((artifact) => artifact.kind === "directive");
const remoteDirective = await Promise.all(
  remoteDirectiveArtifacts.map(async (artifact) => JSON.parse(await fs.readFile(artifact.ref, "utf8")))
);
assert.ok(
  remoteDirective.some((directive) => directive.variables.context.remoteRepoContext?.kind === "github_connector_repo_context"),
  "provider directive should include remoteRepoContext for GitHub connector rehydration"
);
await fs.writeFile(fakeExternalBridgeLogPath, "", "utf8");
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
assert.ok(approvalDashboard.stdout.includes("JOB BOARD"));
assert.ok(approvalDashboard.stdout.includes("approval gate"));
assert.ok(approvalDashboard.stdout.includes("CHECKPOINTS / APPROVAL GATES"));
assert.ok(approvalDashboard.stdout.includes(externalContextPlan.runId.slice(0, 12)));
assert.ok(approvalDashboard.stdout.includes("thehood ui approvals"));
const approvalInbox = await runCli(["ui", "approvals", "--repo", repoPath]);
assert.ok(approvalInbox.stdout.includes("CHECKPOINTS / APPROVAL GATES"));
assert.ok(approvalInbox.stdout.includes("Exact Checkpoint Commands"));
assert.ok(approvalInbox.stdout.includes(`--approve ${externalContextPlan.runId}`));
const approvalInboxJson = JSON.parse((await runCli(["ui", "approvals", "--repo", repoPath, "--json"])).stdout);
assert.ok(approvalInboxJson.pendingApprovals.some((approval) => approval.runId === externalContextPlan.runId));
assert.ok(Array.isArray(approvalInboxJson.recentAutopilotApprovals));
const uiApprovalResult = JSON.parse(
  (await runCli(["ui", "approvals", "--repo", repoPath, "--approve", externalContextPlan.runId, "--json"])).stdout
);
assert.equal(uiApprovalResult.approvalEvents.at(-1).decision, "approve");
assert.equal(await fs.readFile(fakeExternalBridgeLogPath, "utf8"), "");
const externalContextGate = JSON.parse(
  (await runCli(["continue", externalContextPlan.runId, "--repo", repoPath, "--json"], { env: fakeExternalEnv })).stdout
);
assert.equal(externalContextGate.run.state, "awaiting_approval");
assert.equal(externalContextGate.run.approvalRequired, true);
assert.ok(externalContextGate.run.approvalReason.includes("Sending repo context to chatgpt-web:chatgpt-pro"));
assert.ok(externalContextGate.run.approvalReason.includes("Review the transfer manifest before approving"));
assert.equal(externalContextGate.providerResponses[0].data.decision.action, "delegate");
assert.equal(externalContextGate.providerResponses.at(-1).data.decision.action, "request_approval");
const contextTransferManifestArtifact = externalContextGate.run.artifacts.find((artifact) => artifact.kind === "transfer_manifest");
assert.ok(contextTransferManifestArtifact, "repo context gate should attach a transfer manifest");
const contextTransferEvent = externalContextGate.run.events.at(-1);
assert.equal(contextTransferEvent.type, "approval_required");
assert.equal(contextTransferEvent.data.artifactRef, contextTransferManifestArtifact.ref);
assert.ok(contextTransferEvent.data.sourceArtifactRef.includes("/context/"));
assert.equal(contextTransferEvent.data.transfer.purpose, "repo_context");
assert.equal(contextTransferEvent.data.transfer.riskClass, "repo_context");
const contextTransferPreview = await runCli(["transfer", "preview", externalContextPlan.runId, "--repo", repoPath]);
assert.ok(contextTransferPreview.stdout.includes("purpose: repo_context"));
assert.ok(contextTransferPreview.stdout.includes("risk: repo_context"));
assert.ok(contextTransferPreview.stdout.includes("I approve send repo context to chatgpt-web"));
const contextTransferPreviewJson = JSON.parse(
  (await runCli(["transfer", "preview", externalContextPlan.runId, "--repo", repoPath, "--json"])).stdout
);
assert.equal(contextTransferPreviewJson.manifest.purpose, "repo_context");
assert.equal(contextTransferPreviewJson.manifest.risk.class, "repo_context");
assert.equal(contextTransferPreviewJson.manifest.artifacts.length, 1);
const contextTransferApprovalInbox = await runCli(["ui", "approvals", "--repo", repoPath]);
assert.ok(contextTransferApprovalInbox.stdout.includes("transfer_manifest"));
assert.ok(contextTransferApprovalInbox.stdout.includes("thehood transfer preview"));
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
const externalProgressGate = JSON.parse(
  (await runCli(["reconcile", externalContextPlan.runId, "--repo", repoPath, "--json"], { env: fakeExternalEnv })).stdout
);
assert.equal(externalProgressGate.run.state, "completed");
assert.equal(externalProgressGate.run.approvalRequired, true);
assert.ok(externalProgressGate.stopReason.includes("Review the transfer manifest before approving"));
const transferManifestArtifact = externalProgressGate.run.artifacts
  .filter((artifact) => artifact.kind === "transfer_manifest")
  .at(-1);
assert.ok(transferManifestArtifact, "progress packet gate should attach a transfer manifest");
const progressTransferEvent = externalProgressGate.run.events.at(-1);
assert.equal(progressTransferEvent.type, "approval_required");
assert.equal(progressTransferEvent.data.artifactRef, transferManifestArtifact.ref);
assert.ok(progressTransferEvent.data.sourceArtifactRef.includes("/progress/"));
const progressTransferPreview = await runCli(["transfer", "preview", externalContextPlan.runId, "--repo", repoPath]);
assert.ok(progressTransferPreview.stdout.includes("purpose: progress_packet"));
assert.ok(progressTransferPreview.stdout.includes("risk: private_runtime_memory"));
assert.ok(progressTransferPreview.stdout.includes("I approve send progress packet to chatgpt-web"));
const progressTransferPreviewJson = JSON.parse(
  (await runCli(["transfer", "preview", externalContextPlan.runId, "--repo", repoPath, "--json"])).stdout
);
assert.equal(progressTransferPreviewJson.manifest.purpose, "progress_packet");
assert.equal(progressTransferPreviewJson.manifest.risk.class, "private_runtime_memory");
assert.equal(progressTransferPreviewJson.manifest.artifacts.length, 1);
const transferApprovalInbox = await runCli(["ui", "approvals", "--repo", repoPath]);
assert.ok(transferApprovalInbox.stdout.includes("transfer_manifest"));
assert.ok(transferApprovalInbox.stdout.includes("thehood transfer preview"));
await runCli([
  "approve",
  externalContextPlan.runId,
  "--repo",
  repoPath,
  "--reason",
  "I approve send progress packet to chatgpt-web for this read-only smoke."
]);
const externalProgressReconciled = JSON.parse(
  (await runCli(["reconcile", externalContextPlan.runId, "--repo", repoPath, "--json"], { env: fakeExternalEnv })).stdout
);
assert.equal(externalProgressReconciled.reconciliationArtifact.kind, "reconciliation");
assert.equal(externalProgressReconciled.providerResponses[0].data.decision.action, "complete");
assert.deepEqual((await fs.readFile(fakeExternalBridgeLogPath, "utf8")).trim().split("\n"), [
  "no-context",
  "context",
  "progress"
]);

const defaultApprovalPolicy = JSON.parse(
  (await runCli(["approvals", "policy", "show", "--repo", repoPath, "--json"])).stdout
);
assert.equal(defaultApprovalPolicy.mode, "manual");
assert.equal(defaultApprovalPolicy.externalTransfers.mode, "manual");
const enabledApprovalPolicy = JSON.parse(
  (
    await runCli([
      "approvals",
      "policy",
      "set",
      "external-transfers",
      "auto-low-risk",
      "--repo",
      repoPath,
      "--json"
    ])
  ).stdout
);
assert.equal(enabledApprovalPolicy.mode, "manual");
assert.equal(enabledApprovalPolicy.externalTransfers.mode, "auto_low_risk");
const enabledApprovalPolicyText = await runCli(["config", "show", "--repo", repoPath]);
assert.ok(enabledApprovalPolicyText.stdout.includes("externalTransfers: auto_low_risk"));
await fs.writeFile(fakeExternalBridgeLogPath, "", "utf8");
const autoPolicyPlan = JSON.parse(
  (
    await runCli(
      [
        "plan",
        "auto-transfer-policy smoke provider milestone",
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
const autoPolicyInvocationGate = JSON.parse(
  (await runCli(["continue", autoPolicyPlan.runId, "--repo", repoPath, "--json"], { env: fakeExternalEnv })).stdout
);
assert.equal(autoPolicyInvocationGate.run.state, "awaiting_approval");
assert.equal(autoPolicyInvocationGate.run.approvalRequired, true);
assert.ok(autoPolicyInvocationGate.run.approvalReason.includes("Invoking chatgpt-web:chatgpt-pro"));
assert.equal(await fs.readFile(fakeExternalBridgeLogPath, "utf8"), "");
await runCli([
  "approve",
  autoPolicyPlan.runId,
  "--repo",
  repoPath,
  "--reason",
  "I approve invoke chatgpt-web for auto transfer policy smoke."
]);
const autoPolicyContextApproved = JSON.parse(
  (await runCli(["continue", autoPolicyPlan.runId, "--repo", repoPath, "--json"], { env: fakeExternalEnv })).stdout
);
assert.equal(autoPolicyContextApproved.run.state, "completed");
assert.equal(autoPolicyContextApproved.run.approvalRequired, false);
assert.deepEqual(autoPolicyContextApproved.providerResponses.map((response) => response.data.decision.action), [
  "delegate",
  "complete"
]);
assert.deepEqual((await fs.readFile(fakeExternalBridgeLogPath, "utf8")).trim().split("\n"), [
  "no-context",
  "context"
]);
assert.ok(
  autoPolicyContextApproved.run.approvalEvents.some(
    (approval) =>
      approval.reason.includes("Auto-approved by TheHood approval policy") &&
      approval.reason.includes("send repo context to chatgpt-web")
  )
);
assert.ok(
  autoPolicyContextApproved.run.events.some(
    (event) =>
      event.type === "approval_auto_approved" &&
      event.data?.reason === "repo_context_external_transfer" &&
      event.data?.policyDecision === "auto_approve"
  )
);
const autoPolicyProgressReconciled = JSON.parse(
  (await runCli(["reconcile", autoPolicyPlan.runId, "--repo", repoPath, "--json"], { env: fakeExternalEnv })).stdout
);
assert.equal(autoPolicyProgressReconciled.run.state, "completed");
assert.equal(autoPolicyProgressReconciled.run.approvalRequired, false);
assert.equal(autoPolicyProgressReconciled.reconciliationArtifact.kind, "reconciliation");
assert.equal(autoPolicyProgressReconciled.providerResponses[0].data.decision.action, "complete");
assert.deepEqual((await fs.readFile(fakeExternalBridgeLogPath, "utf8")).trim().split("\n"), [
  "no-context",
  "context",
  "progress"
]);
assert.ok(
  autoPolicyProgressReconciled.run.approvalEvents.some(
    (approval) =>
      approval.reason.includes("Auto-approved by TheHood approval policy") &&
      approval.reason.includes("send progress packet to chatgpt-web")
  )
);
assert.ok(
  autoPolicyProgressReconciled.run.events.some(
    (event) =>
      event.type === "approval_auto_approved" &&
      event.data?.reason === "progress_packet_external_transfer" &&
      event.data?.policyDecision === "auto_approve"
  )
);
const autopilotApprovalPolicy = JSON.parse(
  (
    await runCli([
      "approvals",
      "policy",
      "set",
      "mode",
      "autopilot",
      "--repo",
      repoPath,
      "--json"
    ])
  ).stdout
);
assert.equal(autopilotApprovalPolicy.mode, "autopilot");
assert.equal(autopilotApprovalPolicy.externalTransfers.mode, "auto_low_risk");
await fs.writeFile(fakeExternalBridgeLogPath, "", "utf8");
const autopilotPlan = JSON.parse(
  (
    await runCli(
      [
        "plan",
        "autopilot-mode smoke provider milestone",
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
const autopilotCompleted = JSON.parse(
  (await runCli(["continue", autopilotPlan.runId, "--repo", repoPath, "--json"], { env: fakeExternalEnv })).stdout
);
assert.equal(autopilotCompleted.run.state, "completed");
assert.deepEqual(autopilotCompleted.providerResponses.map((response) => response.data.decision.action), [
  "delegate",
  "complete"
]);
assert.deepEqual((await fs.readFile(fakeExternalBridgeLogPath, "utf8")).trim().split("\n"), [
  "no-context",
  "context"
]);
assert.ok(
  autopilotCompleted.run.approvalEvents.some(
    (approval) =>
      approval.reason.includes("Auto-approved by TheHood autopilot policy") &&
      approval.reason.includes("Invoking chatgpt-web:chatgpt-pro")
  )
);
assert.ok(
  autopilotCompleted.run.events.some(
    (event) =>
      event.type === "approval_auto_approved" &&
      event.data?.gate === "provider_invocation" &&
      event.data?.policyDecision === "auto_approve" &&
      event.data?.policyReason.includes("autopilot allowed provider_invocation")
  )
);
assert.ok(
  autopilotCompleted.run.events.some(
    (event) =>
      event.type === "approval_auto_approved" &&
      event.data?.reason === "repo_context_external_transfer" &&
      event.data?.policyReason.includes("autopilot allowed")
  )
);
const autopilotStatus = JSON.parse(
  (await runCli(["status", autopilotPlan.runId, "--repo", repoPath, "--json"])).stdout
);
assert.ok(autopilotStatus.insights.recentAutopilotApprovals.length >= 2);
assert.ok(
  autopilotStatus.insights.recentAutopilotApprovals.some(
    (approval) => approval.gate === "provider_invocation"
  )
);
const autopilotApprovalInbox = JSON.parse(
  (await runCli(["ui", "approvals", "--repo", repoPath, "--json"])).stdout
);
assert.ok(
  autopilotApprovalInbox.recentAutopilotApprovals.some(
    (approval) => approval.runId === autopilotPlan.runId && approval.gate === "provider_invocation"
  )
);
const autopilotApprovalInboxText = await runCli(["ui", "approvals", "--repo", repoPath]);
assert.ok(autopilotApprovalInboxText.stdout.includes("AUTOPILOT LEDGER"));
assert.ok(autopilotApprovalInboxText.stdout.includes("provider_invocation"));
assert.ok(Array.isArray(autopilotApprovalInbox.recentHandoffs));
assert.ok(autopilotApprovalInboxText.stdout.includes("HANDOFFS"));
const resetAutoLowRiskPolicy = JSON.parse(
  (
    await runCli([
      "approvals",
      "policy",
      "set",
      "mode",
      "auto-low-risk",
      "--repo",
      repoPath,
      "--json"
    ])
  ).stdout
);
assert.equal(resetAutoLowRiskPolicy.mode, "auto_low_risk");
assert.equal(resetAutoLowRiskPolicy.externalTransfers.mode, "auto_low_risk");
await fs.mkdir(path.join(repoPath, "notes"), { recursive: true });
for (let index = 0; index < 8; index += 1) {
  await fs.writeFile(
    path.join(repoPath, "notes", `targeted-evidence-${index}.md`),
    `# Targeted Evidence ${index}\n\nTargeted follow-up context marker ${index}.\n${"large requested context line\n".repeat(900)}`,
    "utf8"
  );
}
await fs.writeFile(fakeExternalBridgeLogPath, "", "utf8");
const targetedContextPlan = JSON.parse(
  (
    await runCli(
      [
        "plan",
        "targeted-follow-up-context-smoke provider milestone",
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
const targetedInvocationGate = JSON.parse(
  (await runCli(["continue", targetedContextPlan.runId, "--repo", repoPath, "--json"], { env: fakeExternalEnv })).stdout
);
assert.equal(targetedInvocationGate.run.state, "awaiting_approval");
assert.ok(targetedInvocationGate.run.approvalReason.includes("Invoking chatgpt-web:chatgpt-pro"));
await runCli([
  "approve",
  targetedContextPlan.runId,
  "--repo",
  repoPath,
  "--reason",
  "I approve invoke chatgpt-web for targeted follow-up context smoke."
]);
const targetedContextCompleted = JSON.parse(
  (await runCli(["continue", targetedContextPlan.runId, "--repo", repoPath, "--json"], { env: fakeExternalEnv })).stdout
);
assert.equal(targetedContextCompleted.run.state, "completed");
assert.deepEqual(targetedContextCompleted.providerResponses.map((response) => response.data.decision.action), [
  "delegate",
  "delegate",
  "delegate",
  "delegate",
  "complete"
]);
assert.deepEqual((await fs.readFile(fakeExternalBridgeLogPath, "utf8")).trim().split("\n"), [
  "no-context",
  "context",
  "targeted-context",
  "targeted-context",
  "targeted-context"
]);
const targetedContextArtifacts = targetedContextCompleted.run.artifacts.filter(
  (artifact) => artifact.kind === "context"
);
assert.ok(targetedContextArtifacts.length >= 4);
const latestTargetedContext = JSON.parse(await fs.readFile(targetedContextArtifacts.at(-1).ref, "utf8"));
assert.ok(
  latestTargetedContext.files.some(
    (file) =>
      file.path === "notes/targeted-evidence-7.md" &&
      file.excerpt.includes("Targeted follow-up context marker 7") &&
      file.maxBytes === latestTargetedContext.limits.maxBytesPerRequestedFile
  ),
  "targeted follow-up context should prioritize newly requested files that were not already captured"
);
assert.ok(
  targetedContextCompleted.run.events.filter((event) => event.type === "repo_context_captured").length >= 4
);
assert.ok(
  targetedContextCompleted.run.events.some(
    (event) =>
      event.type === "repo_context_captured" &&
      Array.isArray(event.data?.requestedPaths) &&
      event.data.requestedPaths.includes("notes/targeted-evidence-7.md")
  )
);
assert.ok(
  targetedContextCompleted.run.events.filter(
    (event) => event.type === "approval_auto_approved" && event.data?.reason === "repo_context_external_transfer"
  ).length >= 4
);
await fs.writeFile(
  path.join(repoPath, "notes", "truncated-context.md"),
  `# Truncated Context\n\nTruncated initial context marker.\n${"large requested context line\n".repeat(900)}\nTruncated continuation context marker.\n`,
  "utf8"
);
await fs.writeFile(fakeExternalBridgeLogPath, "", "utf8");
const truncatedContextPlan = JSON.parse(
  (
    await runCli(
      [
        "plan",
        "truncated-follow-up-context-smoke provider milestone",
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
const truncatedInvocationGate = JSON.parse(
  (await runCli(["continue", truncatedContextPlan.runId, "--repo", repoPath, "--json"], { env: fakeExternalEnv })).stdout
);
assert.equal(truncatedInvocationGate.run.state, "awaiting_approval");
assert.ok(truncatedInvocationGate.run.approvalReason.includes("Invoking chatgpt-web:chatgpt-pro"));
await runCli([
  "approve",
  truncatedContextPlan.runId,
  "--repo",
  repoPath,
  "--reason",
  "I approve invoke chatgpt-web for truncated follow-up context smoke."
]);
const truncatedContextCompleted = JSON.parse(
  (await runCli(["continue", truncatedContextPlan.runId, "--repo", repoPath, "--json"], { env: fakeExternalEnv })).stdout
);
assert.equal(truncatedContextCompleted.run.state, "completed");
assert.deepEqual(truncatedContextCompleted.providerResponses.map((response) => response.data.decision.action), [
  "delegate",
  "delegate",
  "delegate",
  "complete"
]);
assert.deepEqual((await fs.readFile(fakeExternalBridgeLogPath, "utf8")).trim().split("\n"), [
  "no-context",
  "context",
  "context",
  "truncated-combined-context"
]);
const truncatedContextArtifacts = truncatedContextCompleted.run.artifacts.filter(
  (artifact) => artifact.kind === "context"
);
const truncatedContextPacks = await Promise.all(
  truncatedContextArtifacts.map(async (artifact) => JSON.parse(await fs.readFile(artifact.ref, "utf8")))
);
const truncatedFileExcerpts = truncatedContextPacks.flatMap((context) =>
  context.files.filter((file) => file.path === "notes/truncated-context.md")
);
assert.equal(truncatedFileExcerpts.length, 2);
assert.equal(truncatedFileExcerpts[0].startByte, 0);
assert.equal(truncatedFileExcerpts[0].endByte, truncatedContextPacks.at(-1).limits.maxBytesPerRequestedFile);
assert.equal(truncatedFileExcerpts[0].truncated, true);
assert.ok(truncatedFileExcerpts[1].startByte > 0);
assert.ok(truncatedFileExcerpts[1].excerpt.includes("Truncated continuation context marker"));
assert.ok(!truncatedFileExcerpts[1].excerpt.includes("Truncated initial context marker"));
assert.equal(truncatedFileExcerpts[1].truncated, false);
assert.ok(
  truncatedContextCompleted.run.events.some(
    (event) =>
      event.type === "repo_context_captured" &&
      Array.isArray(event.data?.requestedPaths) &&
      event.data.requestedPaths.includes("notes/truncated-context.md")
  )
);
const restoredApprovalPolicy = JSON.parse(
  (
    await runCli([
      "approvals",
      "policy",
      "set",
      "mode",
      "manual",
      "--repo",
      repoPath,
      "--json"
    ])
  ).stdout
);
assert.equal(restoredApprovalPolicy.mode, "manual");
assert.equal(restoredApprovalPolicy.externalTransfers.mode, "manual");

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
  "--qa",
  "stub:qa",
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
assert.equal(loopResult.providerResponses.length, 4);
assert.ok(
  loopResult.run.handoffs.some(
    (handoff) =>
      handoff.kind === "agent_handoff" &&
      handoff.fromRole === "orchestrator" &&
      handoff.toRole === "implementer"
  )
);
assert.ok(
  loopResult.run.handoffs.some(
    (handoff) =>
      handoff.kind === "agent_handoff" &&
      handoff.fromRole === "implementer" &&
      handoff.toRole === "verifier"
  )
);
assert.ok(
  loopResult.run.handoffs.some(
    (handoff) =>
      handoff.kind === "agent_handoff" &&
      handoff.fromRole === "qa" &&
      handoff.toRole === "verifier"
  )
);
const finalReportArtifact = loopResult.run.artifacts.find(
  (artifact) => artifact.kind === "report" && artifact.summary.includes("Final report")
);
assert.ok(finalReportArtifact, "verified completed run should attach a final report");
const finalReport = JSON.parse(await fs.readFile(finalReportArtifact.ref, "utf8"));
assert.equal(finalReport.kind, "final_report");
assert.equal(finalReport.finalState, "completed");
assert.equal(finalReport.completedBy.role, "verifier");
assert.equal(finalReport.stopReason, "Verifier approved runtime evidence.");
assert.ok(Array.isArray(finalReport.reviewLanes), "final report should expose review lanes");
const finalReportVerifierLane = finalReport.reviewLanes.find((lane) => lane.id === "review-lane-verifier");
assert.ok(finalReportVerifierLane, "final report should expose verifier review lane");
assert.equal(finalReportVerifierLane.kind, "reviewer");
assert.equal(finalReportVerifierLane.role, "verifier");
assert.equal(finalReportVerifierLane.required, true);
assert.equal(finalReportVerifierLane.state, "satisfied");
assert.equal(finalReportVerifierLane.owner.role, "verifier");
assert.equal(finalReportVerifierLane.owner.assignment, "stub:verifier");
assert.equal(finalReportVerifierLane.canSatisfyRequired, true);
assert.equal(finalReportVerifierLane.satisfiesRequired, true);
const finalReportQaLane = finalReport.reviewLanes.find((lane) => lane.id === "review-lane-qa");
assert.ok(finalReportQaLane, "final report should expose QA validation lane");
assert.equal(finalReportQaLane.kind, "qa");
assert.equal(finalReportQaLane.required, true);
assert.equal(finalReportQaLane.state, "satisfied");
assert.equal(finalReportQaLane.owner.kind, "runtime");
assert.equal(finalReportQaLane.canSatisfyRequired, true);
assert.equal(finalReportQaLane.satisfiesRequired, true);
const finalReportQaTesterLane = finalReport.reviewLanes.find((lane) => lane.id === "review-lane-qa-tester");
assert.ok(finalReportQaTesterLane, "final report should expose QA tester lane");
assert.equal(finalReportQaTesterLane.kind, "tester");
assert.equal(finalReportQaTesterLane.role, "qa");
assert.equal(finalReportQaTesterLane.required, false);
assert.equal(finalReportQaTesterLane.state, "satisfied");
assert.equal(finalReportQaTesterLane.owner.role, "qa");
assert.equal(finalReportQaTesterLane.owner.assignment, "stub:qa");
assert.equal(finalReportQaTesterLane.canSatisfyRequired, false);
assert.equal(finalReportQaTesterLane.satisfiesRequired, false);
assert.ok(Array.isArray(finalReport.crewLanes), "final report should expose crew lanes");
assert.ok(
  finalReport.crewLanes.some(
    (lane) =>
      lane.id === "crew-lane-implement" &&
      lane.authority === "edit" &&
      lane.owner.assignment === "stub:implementer"
  ),
  "final report should expose implementer crew lane"
);
assert.ok(
  finalReport.crewLanes.some(
    (lane) =>
      lane.id === "crew-lane-verify" &&
      lane.authority === "read_only" &&
      lane.reviewLaneId === "review-lane-verifier" &&
      lane.satisfiesRequired === true
  ),
  "final report should expose verifier crew lane"
);
const reviewRoutingArtifact = loopResult.run.artifacts
  .filter((artifact) => artifact.kind === "review_routing")
  .at(-1);
assert.ok(reviewRoutingArtifact, "verified completed run should attach review routing evidence");
const reviewRouting = JSON.parse(await fs.readFile(reviewRoutingArtifact.ref, "utf8"));
assert.equal(reviewRouting.kind, "review_routing");
assert.equal(reviewRouting.riskTier, "medium");
assert.equal(reviewRouting.required.validation, true);
assert.equal(reviewRouting.required.qa, true);
assert.equal(reviewRouting.required.verifier, true);
assert.ok(reviewRouting.reasons.some((reason) => reason.includes("deterministic validation")));
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
const progressPacketArtifact = loopResult.run.artifacts.find(
  (artifact) => artifact.kind === "progress" && artifact.summary.includes("Progress packet")
);
assert.ok(progressPacketArtifact, "verified completed run should attach a progress packet");
const progressPacket = JSON.parse(await fs.readFile(progressPacketArtifact.ref, "utf8"));
assert.equal(progressPacket.kind, "progress_packet");
assert.ok(Array.isArray(progressPacket.reviewLanes.items), "progress packet should expose review lanes");
assert.ok(
  progressPacket.reviewLanes.items.some(
    (lane) =>
      lane.id === "review-lane-verifier" &&
      lane.required === true &&
      lane.state === "satisfied" &&
      lane.owner.assignment === "stub:verifier" &&
      lane.satisfiesRequired === true
  ),
  "progress packet should expose satisfied verifier lane"
);
assert.ok(
  progressPacket.reviewLanes.items.some(
    (lane) =>
      lane.id === "review-lane-qa" &&
      lane.required === true &&
      lane.state === "satisfied" &&
      lane.owner.kind === "runtime" &&
      lane.satisfiesRequired === true
  ),
  "progress packet should expose satisfied QA lane"
);
assert.ok(
  progressPacket.reviewLanes.items.some(
    (lane) =>
      lane.id === "review-lane-qa-tester" &&
      lane.required === false &&
      lane.state === "satisfied" &&
      lane.owner.assignment === "stub:qa" &&
      lane.satisfiesRequired === false
  ),
  "progress packet should expose advisory QA tester lane"
);
assert.ok(
  progressPacket.loopResponsibilities.items.some(
    (responsibility) =>
      responsibility.kind === "test" &&
      responsibility.owner.assignment === "stub:qa" &&
      responsibility.status === "satisfied"
  ),
  "progress packet should expose the QA tester responsibility"
);
assert.ok(Array.isArray(progressPacket.crewLanes.items), "progress packet should expose crew lanes");
assert.ok(
  progressPacket.crewLanes.items.some(
    (lane) =>
      lane.id === "crew-lane-test" &&
      lane.authority === "read_only" &&
      lane.reviewLaneId === "review-lane-qa-tester" &&
      lane.owner.assignment === "stub:qa"
  ),
  "progress packet should expose QA tester crew lane"
);
const verifiedLoopStatusText = await runCli(["status", loopRun.runId, "--repo", loopRepoPath]);
const verifiedLoopStatusJson = JSON.parse(
  (await runCli(["status", loopRun.runId, "--repo", loopRepoPath, "--json"])).stdout
);
assert.equal(verifiedLoopStatusJson.insights.latestReviewRouting.artifact.ref, reviewRoutingArtifact.ref);
assert.equal(verifiedLoopStatusJson.insights.latestReviewRouting.riskTier, "medium");
assert.equal(verifiedLoopStatusJson.insights.latestReviewRouting.action, "run_verifier");
assert.equal(
  verifiedLoopStatusJson.insights.canonicalMemory.currentRun.artifacts.latestReviewRouting.ref,
  reviewRoutingArtifact.ref
);
assert.ok(Array.isArray(verifiedLoopStatusJson.insights.crewLanes.lanes));
assert.ok(
  verifiedLoopStatusJson.insights.crewLanes.lanes.some(
    (lane) => lane.id === "crew-lane-verify" && lane.reviewLaneId === "review-lane-verifier"
  )
);
assert.equal(verifiedLoopStatusJson.agentBoard.kind, "agent_board");
assert.equal(verifiedLoopStatusJson.agentBoard.scope, "run");
assert.ok(
  verifiedLoopStatusJson.agentBoard.cards.some(
    (card) => card.role === "verifier" && card.status === "satisfied" && card.run?.artifactRefs.length > 0
  ),
  "status JSON should expose a verifier agent card with evidence refs"
);
const verifiedLoopAgentBoard = JSON.parse(
  (await runCli(["agent-board", loopRun.runId, "--repo", loopRepoPath, "--json"])).stdout
);
assert.equal(verifiedLoopAgentBoard.runId, loopRun.runId);
assert.ok(
  verifiedLoopAgentBoard.cards.some(
    (card) => card.role === "qa" && card.readOnly === true && card.run?.artifactRefs.length > 0
  ),
  "agent-board should expose QA as a read-only visible card with evidence refs"
);
assert.ok(verifiedLoopStatusText.stdout.includes("crew lanes:"));
assert.ok(verifiedLoopStatusText.stdout.includes("review lanes:"));
assert.ok(verifiedLoopStatusText.stdout.includes("review routing:"));
assert.ok(verifiedLoopStatusText.stdout.includes("reviewer"));
assert.ok(verifiedLoopStatusText.stdout.includes("tester"));
assert.ok(verifiedLoopStatusText.stdout.includes("qa"));
assert.ok(verifiedLoopStatusText.stdout.includes("owner=Agent 3 / QA (stub:qa)"));
assert.ok(verifiedLoopStatusText.stdout.includes("owner=Agent 4 / Verifier (stub:verifier)"));
assert.ok(verifiedLoopStatusText.stdout.includes("satisfies"));
const directiveArtifacts = loopResult.run.artifacts.filter((artifact) => artifact.kind === "directive");
assert.equal(directiveArtifacts.length, 4);
const qaDirectiveArtifact = directiveArtifacts.find((artifact) => artifact.summary.startsWith("qa directive"));
assert.ok(qaDirectiveArtifact, "QA directive artifact should be captured");
const qaDirective = JSON.parse(await fs.readFile(qaDirectiveArtifact.ref, "utf8"));
assert.equal(qaDirective.toolPermissions.edit, false);
assert.equal(qaDirective.outputContract.requiredDataKey, "qaResult");
const verifierDirectiveArtifact = directiveArtifacts.find((artifact) => artifact.summary.startsWith("verifier directive"));
assert.ok(verifierDirectiveArtifact, "verifier directive artifact should be captured");
const verifierDirective = JSON.parse(await fs.readFile(verifierDirectiveArtifact.ref, "utf8"));
assert.equal(verifierDirective.toolPermissions.edit, false);
assert.equal(verifierDirective.outputContract.requiredDataKey, "verificationResult");

const autopilotLoopRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-autopilot-loop-smoke-"));
await runCli(["init", "--repo", autopilotLoopRepoPath]);
await fs.writeFile(
  path.join(autopilotLoopRepoPath, "package.json"),
  JSON.stringify(
    {
      scripts: {
        typecheck: "node -e \"process.stdout.write('autopilot validation ok\\\\n')\""
      }
    },
    null,
    2
  ),
  "utf8"
);
const autopilotLoopPolicy = JSON.parse(
  (
    await runCli([
      "approvals",
      "policy",
      "set",
      "mode",
      "autopilot",
      "--repo",
      autopilotLoopRepoPath,
      "--json"
    ])
  ).stdout
);
assert.equal(autopilotLoopPolicy.mode, "autopilot");
const autopilotLoopRun = JSON.parse(
  (
    await runCli([
      "run",
      "exercise autopilot deterministic loop",
      "--repo",
      autopilotLoopRepoPath,
      "--orchestrator",
      "stub:orchestrator",
      "--implementer",
      "stub:implementer",
      "--qa",
      "stub:qa",
      "--verifier",
      "stub:verifier",
      "--critic",
      "stub:critic",
      "--json"
    ])
  ).stdout
);
assert.equal(autopilotLoopRun.state, "delegating");
assert.equal(autopilotLoopRun.approvalRequired, false);
assert.ok(
  autopilotLoopRun.approvalEvents.some((approval) =>
    approval.reason.includes("Auto-approved by TheHood autopilot policy")
  )
);
const autopilotLoopResult = JSON.parse(
  (await runCli(["loop", autopilotLoopRun.runId, "--repo", autopilotLoopRepoPath, "--json"])).stdout
);
assert.equal(autopilotLoopResult.run.state, "completed");
assert.equal(autopilotLoopResult.stopKind, "terminal");
assert.equal(autopilotLoopResult.providerResponses.length, 4);
assert.equal(autopilotLoopResult.cycles.length, 1);
const completedLoopText = await runCli(["loop", autopilotLoopRun.runId, "--repo", autopilotLoopRepoPath]);
assert.ok(completedLoopText.stdout.includes("stopKind: terminal"));
assert.ok(completedLoopText.stdout.includes("cycle log:"));
const autopilotOneShotLoop = JSON.parse(
  (
    await runCli([
      "run",
      "exercise one-shot autopilot loop",
      "--repo",
      autopilotLoopRepoPath,
      "--orchestrator",
      "stub:orchestrator",
      "--implementer",
      "stub:implementer",
      "--qa",
      "stub:qa",
      "--verifier",
      "stub:verifier",
      "--critic",
      "stub:critic",
      "--loop",
      "--json"
    ])
  ).stdout
);
assert.equal(autopilotOneShotLoop.run.state, "completed");
assert.equal(autopilotOneShotLoop.stopKind, "terminal");
assert.equal(autopilotOneShotLoop.providerResponses.length, 4);

const qaRevisionRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-qa-revision-smoke-"));
await runCli(["init", "--repo", qaRevisionRepoPath]);
await fs.writeFile(
  path.join(qaRevisionRepoPath, "package.json"),
  JSON.stringify(
    {
      scripts: {
        typecheck: "node -e \"process.stdout.write('qa revision validation ok\\\\n')\""
      }
    },
    null,
    2
  ),
  "utf8"
);
const qaRevisionRun = JSON.parse(
  (
    await runCli([
      "run",
      "qa-revision-loop-smoke exercise repair delegation",
      "--repo",
      qaRevisionRepoPath,
      "--orchestrator",
      "stub:orchestrator",
      "--implementer",
      "stub:implementer",
      "--qa",
      "stub:qa",
      "--verifier",
      "stub:verifier",
      "--critic",
      "stub:critic",
      "--json"
    ])
  ).stdout
);
await runCli(["approve", qaRevisionRun.runId, "--repo", qaRevisionRepoPath, "--reason", "smoke-approved"]);
const qaRevisionContinue = JSON.parse(
  (await runCli(["continue", qaRevisionRun.runId, "--repo", qaRevisionRepoPath, "--json"])).stdout
);
assert.equal(qaRevisionContinue.run.state, "completed");
assert.equal(
  qaRevisionContinue.run.events.filter((event) => event.type === "agent_response").length,
  7
);
assert.ok(
  qaRevisionContinue.providerResponses.some((response) => response.data.qaResult?.verdict === "needs_revision"),
  "QA revision smoke should include the first QA revision finding"
);
assert.ok(
  qaRevisionContinue.providerResponses.some((response) =>
    response.data.implementationResult?.status === "no_change" &&
    response.summary.includes("handled the runtime revision packet")
  ),
  "implementer should receive the revision packet on the repair pass"
);
const qaRevisionPacketArtifact = qaRevisionContinue.run.artifacts.find(
  (artifact) => artifact.kind === "revision_packet"
);
assert.ok(qaRevisionPacketArtifact, "QA revision should attach a revision packet");
const qaRevisionPacket = JSON.parse(await fs.readFile(qaRevisionPacketArtifact.ref, "utf8"));
assert.equal(qaRevisionPacket.kind, "revision_packet");
assert.equal(qaRevisionPacket.sourceRole, "qa");
assert.equal(qaRevisionPacket.reasonCode, "qa_needs_revision");
assert.ok(qaRevisionPacket.evidenceRefs.some((ref) => ref.includes("/agent/")));
const qaRevisionFinalReportArtifact = qaRevisionContinue.run.artifacts.find(
  (artifact) => artifact.kind === "report" && artifact.summary.includes("Final report")
);
assert.ok(qaRevisionFinalReportArtifact, "QA revision loop should attach a final report");
const qaRevisionFinalReport = JSON.parse(await fs.readFile(qaRevisionFinalReportArtifact.ref, "utf8"));
assert.ok(Array.isArray(qaRevisionFinalReport.revisionTrail), "final report should expose revision trail");
assert.ok(
  qaRevisionFinalReport.revisionTrail.some(
    (item) =>
      item.packetArtifactRef === qaRevisionPacketArtifact.ref &&
      item.status === "reviewed" &&
      item.repairResponseRef &&
      item.validationArtifactRefs.length > 0 &&
      item.reviewResponseRefs.length > 0
  ),
  "final report revision trail should link repair, validation, and review evidence"
);
assert.ok(
  qaRevisionContinue.run.events.some(
    (event) => event.type === "revision_delegated" && event.data?.reasonCode === "qa_needs_revision"
  )
);
assert.ok(
  qaRevisionContinue.run.handoffs.some(
    (handoff) =>
      handoff.kind === "agent_handoff" &&
      handoff.fromRole === "qa" &&
      handoff.toRole === "implementer" &&
      handoff.artifactRefs?.includes(qaRevisionPacketArtifact.ref)
  ),
  "QA revision should hand repair back to the implementer"
);
const qaRevisionStatus = JSON.parse(
  (await runCli(["status", qaRevisionRun.runId, "--repo", qaRevisionRepoPath, "--json"])).stdout
);
assert.equal(qaRevisionStatus.insights.latestRevisionPacket.reasonCode, "qa_needs_revision");
assert.equal(qaRevisionStatus.insights.revisionTrail.kind, "revision_trail");
assert.ok(
  qaRevisionStatus.insights.revisionTrail.items.some(
    (item) =>
      item.packetArtifactRef === qaRevisionPacketArtifact.ref &&
      item.status === "reviewed" &&
      item.repairResponseRef &&
      item.validationArtifactRefs.length > 0 &&
      item.reviewResponseRefs.length > 0
  ),
  "status insights should expose the reviewed repair trail"
);
assert.equal(
  qaRevisionStatus.insights.canonicalMemory.currentRun.artifacts.latestRevisionPacket.ref,
  qaRevisionPacketArtifact.ref
);
const qaRevisionProgressArtifact = qaRevisionContinue.run.artifacts.find(
  (artifact) => artifact.kind === "progress" && artifact.summary.includes("Progress packet")
);
assert.ok(qaRevisionProgressArtifact, "QA revision loop should still complete with a progress packet");
const qaRevisionProgress = JSON.parse(await fs.readFile(qaRevisionProgressArtifact.ref, "utf8"));
assert.equal(qaRevisionProgress.latest.revisionPacket.ref, qaRevisionPacketArtifact.ref);
assert.ok(Array.isArray(qaRevisionProgress.revisionTrail.items), "progress packet should expose revision trail");
assert.ok(
  qaRevisionProgress.revisionTrail.items.some(
    (item) => item.packetArtifactRef === qaRevisionPacketArtifact.ref && item.status === "reviewed"
  ),
  "progress packet should expose reviewed revision trail item"
);
const qaRevisionStatusText = await runCli(["status", qaRevisionRun.runId, "--repo", qaRevisionRepoPath]);
assert.ok(qaRevisionStatusText.stdout.includes("revision packet:"));
assert.ok(qaRevisionStatusText.stdout.includes("revision trail:"));
assert.ok(qaRevisionStatusText.stdout.includes("reasonCode: qa_needs_revision"));

const verifierRevisionRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-verifier-revision-smoke-"));
await runCli(["init", "--repo", verifierRevisionRepoPath]);
await fs.writeFile(
  path.join(verifierRevisionRepoPath, "package.json"),
  JSON.stringify(
    {
      scripts: {
        typecheck: "node -e \"process.stdout.write('verifier revision validation ok\\\\n')\""
      }
    },
    null,
    2
  ),
  "utf8"
);
const verifierRevisionRun = JSON.parse(
  (
    await runCli([
      "run",
      "verifier-revision-loop-smoke exercise repair delegation",
      "--repo",
      verifierRevisionRepoPath,
      "--orchestrator",
      "stub:orchestrator",
      "--implementer",
      "stub:implementer",
      "--qa",
      "stub:qa",
      "--verifier",
      "stub:verifier",
      "--critic",
      "stub:critic",
      "--json"
    ])
  ).stdout
);
await runCli(["approve", verifierRevisionRun.runId, "--repo", verifierRevisionRepoPath, "--reason", "smoke-approved"]);
const verifierRevisionContinue = JSON.parse(
  (await runCli(["continue", verifierRevisionRun.runId, "--repo", verifierRevisionRepoPath, "--json"])).stdout
);
assert.equal(verifierRevisionContinue.run.state, "completed");
assert.equal(
  verifierRevisionContinue.run.events.filter((event) => event.type === "agent_response").length,
  8
);
assert.ok(
  verifierRevisionContinue.providerResponses.some((response) => response.data.verificationResult?.verdict === "revise"),
  "verifier revision smoke should include a revise verdict"
);
assert.ok(
  verifierRevisionContinue.run.artifacts.some(
    (artifact) => artifact.kind === "critic_trigger" && artifact.summary.includes("verifier_failed")
  ),
  "verifier revision should still trigger advisory critic review"
);
const verifierRevisionPacketArtifact = verifierRevisionContinue.run.artifacts.find(
  (artifact) => artifact.kind === "revision_packet"
);
assert.ok(verifierRevisionPacketArtifact, "verifier revision should attach a revision packet");
const verifierRevisionPacket = JSON.parse(await fs.readFile(verifierRevisionPacketArtifact.ref, "utf8"));
assert.equal(verifierRevisionPacket.sourceRole, "verifier");
assert.equal(verifierRevisionPacket.reasonCode, "verifier_revise");
assert.ok(
  verifierRevisionContinue.run.handoffs.some(
    (handoff) =>
      handoff.kind === "agent_handoff" &&
      handoff.fromRole === "verifier" &&
      handoff.toRole === "implementer" &&
      handoff.artifactRefs?.includes(verifierRevisionPacketArtifact.ref)
  ),
  "verifier revision should hand repair back to the implementer"
);

const maxIterationRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-max-iterations-smoke-"));
await runCli(["init", "--repo", maxIterationRepoPath]);
const maxIterationConfig = JSON.parse(
  (await runCli(["config", "set", "max-iterations", "1", "--repo", maxIterationRepoPath, "--json"])).stdout
);
assert.equal(maxIterationConfig.defaults.maxIterations, 1);
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
      "--qa",
      "stub:qa",
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
      "--qa",
      "stub:qa",
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
  failingValidationContinue.providerResponses.some((response) => response.data.critiqueResult?.verdict === "acceptable"),
  "failing validation should trigger a critic response before verifier gate"
);
const failingCriticTriggerArtifact = failingValidationContinue.run.artifacts.find(
  (artifact) => artifact.kind === "critic_trigger"
);
assert.ok(failingCriticTriggerArtifact, "failing validation should attach a critic trigger artifact");
const failingCriticTrigger = JSON.parse(await fs.readFile(failingCriticTriggerArtifact.ref, "utf8"));
assert.equal(failingCriticTrigger.reasonCode, "validation_mismatch");
assert.equal(failingCriticTrigger.called, true);
const failingValidationSummaryArtifact = failingValidationContinue.run.artifacts.find(
  (artifact) => artifact.kind === "metadata" && artifact.summary.includes("Validation summary")
);
assert.ok(failingValidationSummaryArtifact);
assert.ok(failingCriticTrigger.evidenceRefs.includes(failingValidationSummaryArtifact.ref));
assert.equal(typeof failingCriticTrigger.criticResponseRef, "string");
const failingValidationStatus = JSON.parse(
  (await runCli(["status", failingValidationRun.runId, "--repo", failingValidationRepoPath, "--json"])).stdout
);
assert.equal(failingValidationStatus.insights.latestCriticTrigger.reasonCode, "validation_mismatch");
assert.ok(
  failingValidationStatus.insights.reviewLanes.some(
    (lane) => lane.id === "review-lane-critic" && lane.sourceKind === "critic_response" && lane.canSatisfyRequired === false
  ),
  "critic trigger should expose advisory critic lane"
);
const failingValidationStatusText = await runCli(["status", failingValidationRun.runId, "--repo", failingValidationRepoPath]);
assert.ok(failingValidationStatusText.stdout.includes("critic trigger:"));
assert.ok(failingValidationStatusText.stdout.includes("reasonCode: validation_mismatch"));
assert.ok(
  !failingValidationContinue.run.artifacts.some(
    (artifact) => artifact.kind === "report" && artifact.summary.includes("Final report")
  ),
  "failing validation should not produce a final report"
);

const { createFallbackAgentResponse, parseLocalAgentOutput } = await import(
  pathToFileURL(path.join(root, "dist", "providers", "localCommand.js")).href
);
const { buildAgentResponseSchema } = await import(
  pathToFileURL(path.join(root, "dist", "providers", "responseSchema.js")).href
);
const { validateAgentResponse } = await import(
  pathToFileURL(path.join(root, "dist", "runtime", "responseContracts.js")).href
);
const { buildCodexCliArgs, resolveCodexCliModel } = await import(
  pathToFileURL(path.join(root, "dist", "providers", "codexCli.js")).href
);
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
    directiveAck: {
      runId: "fake-run",
      nonce: "fake-directive-nonce",
      responseField: "thehoodDirectiveAck"
    },
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
assert.deepEqual(fallbackProviderOutput.data.verificationResult.thehoodDirectiveAck, {
  runId: "fake-run",
  nonce: "fake-directive-nonce",
  responseField: "thehoodDirectiveAck"
});
const fakeVerifierSchema = buildAgentResponseSchema(fakeVerifierRequest);
assert.ok(
  fakeVerifierSchema.properties.data.properties.verificationResult.required.includes("thehoodDirectiveAck"),
  "provider response schema should require directive ack inside role payload"
);
assert.equal(fakeVerifierSchema.properties.data.properties.verificationResult.additionalProperties, false);
assert.deepEqual(
  fakeVerifierSchema.properties.data.properties.verificationResult.required.sort(),
  Object.keys(fakeVerifierSchema.properties.data.properties.verificationResult.properties).sort(),
  "provider response schema should satisfy strict structured-output required fields"
);
assert.throws(
  () => validateAgentResponse("verifier", fakeVerifierRequest.directive, {
    status: "ok",
    summary: "stale ack",
    data: {
      verificationResult: {
        verdict: "approve",
        summary: "wrong run",
        thehoodDirectiveAck: {
          runId: "other-run",
          nonce: "fake-directive-nonce",
          responseField: "thehoodDirectiveAck"
        }
      }
    }
  }),
  /does not match the current directive/
);
const schemaContext = {
  schema: {
    type: "object"
  },
  schemaPath: path.join(loopRepoPath, "agent-response.schema.json"),
  workspacePath: loopRepoPath
};
const codexArgs = buildCodexCliArgs(fakeVerifierRequest, schemaContext);
assert.deepEqual(codexArgs.slice(0, 5), ["exec", "--cd", loopRepoPath, "--sandbox", "read-only"]);
assert.equal(codexArgs.includes("--ask-for-approval"), false);
assert.equal(codexArgs.includes("--output-schema"), true);
assert.equal(codexArgs[codexArgs.indexOf("--output-schema") + 1], schemaContext.schemaPath);
assert.equal(codexArgs.at(-1), "-");
assert.equal(resolveCodexCliModel("spark"), "gpt-5.3-codex-spark");
assert.equal(resolveCodexCliModel("gpt-5.4"), "gpt-5.4");
assert.equal(resolveCodexCliModel("configured"), "default");
const sparkVerifierRequest = {
  ...fakeVerifierRequest,
  assignment: {
    provider: "codex-cli",
    model: "spark"
  }
};
const codexSparkArgs = buildCodexCliArgs(sparkVerifierRequest, schemaContext);
assert.equal(codexSparkArgs[codexSparkArgs.indexOf("--model") + 1], "gpt-5.3-codex-spark");
const configuredCodexArgs = buildCodexCliArgs({
  ...fakeVerifierRequest,
  assignment: {
    provider: "codex-cli",
    model: "configured"
  }
}, schemaContext);
assert.equal(configuredCodexArgs.includes("--model"), false);
const claudeArgs = buildClaudeCodeArgs(fakeVerifierRequest, schemaContext);
assert.ok(claudeArgs.includes("--print"));
assert.equal(claudeArgs.includes("--json-schema"), true);
assert.ok(claudeArgs.includes("Read,Glob,Grep,Bash"));
assert.equal(claudeArgs.includes("-"), false);
const configuredClaudeArgs = buildClaudeCodeArgs({
  ...fakeVerifierRequest,
  assignment: {
    provider: "claude-code",
    model: "configured"
  }
}, schemaContext);
assert.equal(configuredClaudeArgs.includes("--model"), false);
const sonnetClaudeArgs = buildClaudeCodeArgs({
  ...fakeVerifierRequest,
  assignment: {
    provider: "claude-code",
    model: "sonnet"
  }
}, schemaContext);
assert.equal(sonnetClaudeArgs[sonnetClaudeArgs.indexOf("--model") + 1], "sonnet");

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
