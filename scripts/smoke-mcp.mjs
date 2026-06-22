import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cliPath = path.join(root, "dist", "cli", "main.js");
process.env.THEHOOD_CHATGPT_WEB_COMMAND = "";
process.env.THEHOOD_CHATGPT_WEB_MODEL_CONFIRMED = "0";
process.env.THEHOOD_CHATGPT_WEB_ALLOW_UNVERIFIED_MODEL = "0";
process.env.THEHOOD_CHATGPT_WEB_GITHUB_CONNECTOR_CONFIRMED = "0";
process.env.THEHOOD_CHATGPT_WEB_CDP_URL = "http://127.0.0.1:9";

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
await runRawCommand("git", ["init"], repoPath);
await fs.writeFile(path.join(repoPath, "README.md"), "# MCP Smoke Repo\n\nProvider access modes are connector-ready.\n", "utf8");
await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
await fs.writeFile(
  path.join(repoPath, "src", "gateway.ts"),
  "export const connectorMode = 'mcp-connector';\n",
  "utf8"
);
await runCommand(["init", "--repo", repoPath]);

const tunnelReport = JSON.parse(
  await runCommand(["mcp", "tunnel", "--tunnel-id", "tunnel_0123456789abcdef", "--profile", "thehood-local", "--json"])
);
assert.ok(tunnelReport.installed.initCommand.includes("sample_mcp_stdio_local"));
assert.ok(tunnelReport.installed.initCommand.includes("--mcp-command 'thehood mcp'"));
assert.equal(tunnelReport.installed.doctorCommand, "tunnel-client doctor --profile thehood-local --explain");
assert.equal(tunnelReport.installed.runCommand, "tunnel-client run --profile thehood-local");
assert.ok(tunnelReport.local.initCommand.includes("dist/cli/main.js"));
assert.ok(
  tunnelReport.chatGptSteps.some((step) => step.includes("thehood_doctor") && step.includes("thehood_repo_tree")),
  "tunnel report should include deterministic ChatGPT connector validation steps"
);
assert.ok(
  tunnelReport.notes.some((note) => note.includes("separate from the chatgpt-web agent bridge")),
  "tunnel report should keep MCP connector mode separate from the ChatGPT Web bridge"
);
assert.ok(
  tunnelReport.notes.some((note) => note.includes("trusted MCP hosts")),
  "tunnel report should warn that connector tool results disclose repo/run data"
);

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
assert.ok(happyPath[0].result.instructions.includes("approval=none"));
assert.ok(happyPath[0].result.instructions.includes("autopilot"));
assert.ok(happyPath[0].result.instructions.includes("thehood mcp tunnel --tunnel-id <id> --profile thehood-local"));
assert.ok(happyPath[0].result.instructions.includes("Secure MCP Tunnel"));
assert.ok(happyPath[0].result.instructions.includes("read-only repo gateway tools"));
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_plan"),
  "tools/list should expose thehood_plan"
);
const continueToolDefinition = happyPath[1].result.tools.find((tool) => tool.name === "thehood_continue");
assert.ok(continueToolDefinition.description.includes("approval=none"));
assert.ok(continueToolDefinition.description.includes("runtime autopilot"));
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_consult"),
  "tools/list should expose thehood_consult"
);
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_summon"),
  "tools/list should expose thehood_summon"
);
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_fanout"),
  "tools/list should expose thehood_fanout"
);
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_loop"),
  "tools/list should expose thehood_loop"
);
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_reconcile"),
  "tools/list should expose thehood_reconcile"
);
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_transfer_preview"),
  "tools/list should expose thehood_transfer_preview"
);
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_doctor"),
  "tools/list should expose thehood_doctor"
);
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_pro_access"),
  "tools/list should expose thehood_pro_access"
);
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_model_access"),
  "tools/list should expose thehood_model_access"
);
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_recommend_loop"),
  "tools/list should expose thehood_recommend_loop"
);
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_agent_board"),
  "tools/list should expose thehood_agent_board"
);
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_repo_read_file"),
  "tools/list should expose thehood_repo_read_file"
);
assert.ok(
  happyPath[1].result.tools.some((tool) => tool.name === "thehood_repo_search"),
  "tools/list should expose thehood_repo_search"
);
assert.equal(happyPath[2].result.structuredContent.status, "created");
assert.equal(happyPath[2].result.structuredContent.mode, "plan");
const initialContinueAction = happyPath[2].result.structuredContent.next_actions.find(
  (nextAction) => nextAction.tool === "thehood_continue"
);
assert.equal(initialContinueAction.arguments.approval, "none");
assert.ok(initialContinueAction.description.includes("approval=none"));
assert.ok(initialContinueAction.description.includes("autopilot"));

const recommendLoopPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "thehood_recommend_loop",
      arguments: {
        goal: "Use Hood loops to fix flaky checkout tests before preview release.",
        repo_path: repoPath,
        acceptance_criteria: ["Preview docs describe the beta loop behavior honestly."],
        validation_commands: ["npm run smoke:mcp"],
        allowed_paths: ["README.md", "docs/LOOP_SELECTION_UX.md"],
        forbidden_changes: ["Do not publish private run logs."],
        max_iterations: 5
      }
    }
  }
]);
const recommendLoopContent = recommendLoopPath[1].result.structuredContent;
assert.equal(recommendLoopContent.kind, "loop_recommendation");
assert.equal(recommendLoopContent.contract.iterationBudget, 5);
assert.equal(recommendLoopContent.runAction.tool, "thehood_orchestrate");
assert.ok(
  recommendLoopContent.runAction.arguments.constraints.some((constraint) => constraint.startsWith("Loop stack:")),
  "MCP loop recommendation should carry stack context into the runtime action"
);
assert.ok(
  recommendLoopContent.actions.some((action) => action.action === "run_loop" && action.tool === "thehood_orchestrate"),
  "MCP loop recommendation should expose a run-loop card action"
);
assert.ok(
  recommendLoopContent.actions.some((action) => action.action === "edit_contract"),
  "MCP loop recommendation should expose an edit-contract card action"
);
assert.ok(recommendLoopContent.card.title.startsWith("Recommended loop:"));
assert.ok(
  recommendLoopContent.card.actions.some((action) => action.action === "run_loop" && action.tool === "thehood_orchestrate"),
  "MCP loop recommendation card should expose the runtime run action directly"
);
assert.ok(
  recommendLoopContent.card.sections.some((section) => section.id === "contract"),
  "MCP loop recommendation card should include a completion contract section"
);
assert.equal(recommendLoopContent.artifact.surface, "dashboard");
assert.equal(recommendLoopContent.artifact.manifest.title, "TheHood Loop Plan");
assert.ok(Array.isArray(recommendLoopContent.artifact.manifest.blocks));
assert.ok(Array.isArray(recommendLoopContent.artifact.snapshot.datasets.loop_recipes));
assert.ok(Array.isArray(recommendLoopContent.artifact.snapshot.datasets.loop_stack));
assert.ok(Array.isArray(recommendLoopContent.artifact.snapshot.datasets.card_actions));
assert.ok(
  recommendLoopContent.contract.acceptanceCriteria.includes("Preview docs describe the beta loop behavior honestly."),
  "MCP loop recommendation should accept edited contract criteria"
);
assert.ok(
  recommendLoopContent.contract.validationCommands.includes("npm run smoke:mcp"),
  "MCP loop recommendation should accept edited validation commands"
);
assert.ok(
  recommendLoopContent.alternatives.some((candidate) => candidate.recipe.id === "completion-contract") ||
    recommendLoopContent.recommended.recipe.id === "completion-contract",
  "loop recommendation should keep release-facing completion contract visible"
);

const proAccessPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_pro_access",
      arguments: {
        repo_path: repoPath,
        goal: "Validate a strategic Pro conductor UX pivot.",
        constraints: ["local-only preflight"]
      }
    }
  }
]);
const proAccessContent = proAccessPath[1].result.structuredContent;
assert.equal(proAccessContent.kind, "pro_access_preflight");
assert.equal(proAccessContent.provider, "chatgpt-web:chatgpt-pro");
assert.equal(proAccessContent.codex_host_policy_boundary.status, "outside_thehood_runtime_control");
assert.equal(proAccessContent.bridge.github_connector_confirmed, false);
assert.ok(
  proAccessContent.recommended_paths.some((path) => path.id === "chatgpt_mcp_connector"),
  "pro access preflight should return a connector-mode fallback"
);
const proConnectorPath = proAccessContent.recommended_paths.find((path) => path.id === "chatgpt_mcp_connector");
assert.ok(proConnectorPath.setup_command.includes("--profile thehood-local"));
assert.ok(proConnectorPath.handoff_prompt.includes("Call TheHood MCP tools"));
assert.ok(
  proAccessContent.recommended_paths.some((path) => path.id === "codex_agent_bridge"),
  "pro access preflight should return direct bridge readiness"
);
assert.equal(proAccessContent.provider_response_count, undefined);

const modelAccessPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_model_access",
      arguments: {
        repo_path: repoPath,
        agents: ["claude-code:opus", "codex-cli:gpt-5.5"],
        purpose: "Public-readiness review.",
        context_kind: "repo_context",
        constraints: ["local-only preflight"]
      }
    }
  }
]);
const modelAccessContent = modelAccessPath[1].result.structuredContent;
assert.equal(modelAccessContent.kind, "model_access_preflight");
assert.equal(modelAccessContent.local_only, true);
assert.equal(modelAccessContent.sends_repo_context, false);
assert.equal(modelAccessContent.data_boundary.context_kind, "repo_context");
assert.equal(modelAccessContent.repo_visibility.default_gate, "user_choice_required");
assert.equal(modelAccessContent.repo_visibility.clean, false);
assert.ok(
  modelAccessContent.repo_visibility.user_choices.some(
    (choice) => choice.id === "commit_push_checkpoint_then_remote" && choice.recommended === true
  ),
  "dirty model access preflight should make commit/push the recommended user choice"
);
assert.ok(
  modelAccessContent.repo_visibility.user_choices.some((choice) => choice.id === "cancel_external_model_access"),
  "dirty model access preflight should include cancel choice"
);
assert.equal(modelAccessContent.codex_host_policy_boundary.status, "outside_thehood_runtime_control");
assert.ok(modelAccessContent.approval_packet.copy.includes("claude-code:opus"));
assert.ok(modelAccessContent.approval_packet.copy.includes("codex-cli:gpt-5.5"));
assert.ok(modelAccessContent.approval_packet.copy.includes("repo context"));
assert.ok(modelAccessContent.approval_packet.copyable_text_block.startsWith("```text\n"));
assert.ok(modelAccessContent.approval_packet.copyable_text_block.includes(modelAccessContent.approval_packet.copy));
assert.ok(modelAccessContent.approval_packet.copyable_text_block.endsWith("\n```"));
assert.ok(modelAccessContent.approval_packet.display_hint.includes("fenced text block"));
assert.ok(!modelAccessContent.approval_packet.copy.includes(".."));
assert.ok(
  modelAccessContent.destinations.some((destination) => destination.assignment === "claude-code:opus"),
  "model access preflight should include Claude destination"
);
assert.ok(
  modelAccessContent.destinations.every((destination) => typeof destination.model_status === "string"),
  "model access preflight should report model status for each destination"
);
assert.ok(
  modelAccessContent.destinations.some((destination) => destination.assignment === "codex-cli:gpt-5.5"),
  "model access preflight should include Codex/GPT destination"
);
assert.ok(
  modelAccessContent.recommended_paths.some((path) => path.id === "approve_packet_then_call_models"),
  "model access preflight should include compact packet approval path"
);
assert.ok(
  modelAccessContent.recommended_paths.some((path) => path.id === "commit_push_checkpoint_then_remote"),
  "dirty model access preflight should recommend commit/push before remote review"
);
assert.ok(
  modelAccessContent.recommended_paths.some((path) => path.id === "approve_local_context_transfer"),
  "dirty model access preflight should include explicit local context approval path"
);
assert.ok(
  modelAccessContent.recommended_paths.some((path) => path.id === "abstract_no_repo_context_prompt"),
  "model access preflight should include no-repo-context fallback"
);
assert.equal(modelAccessContent.provider_response_count, undefined);

const remoteReadyRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-mcp-remote-ready-"));
await runRawCommand("git", ["init"], remoteReadyRepoPath);
await runRawCommand("git", ["branch", "-M", "main"], remoteReadyRepoPath);
await fs.writeFile(path.join(remoteReadyRepoPath, "README.md"), "# MCP Remote Ready Repo\n", "utf8");
await runCommand(["init", "--repo", remoteReadyRepoPath]);
await runRawCommand("git", ["config", "user.name", "TheHood Smoke"], remoteReadyRepoPath);
await runRawCommand("git", ["config", "user.email", "smoke@example.invalid"], remoteReadyRepoPath);
await runRawCommand("git", ["add", "README.md"], remoteReadyRepoPath);
await runRawCommand("git", ["commit", "-m", "init"], remoteReadyRepoPath);
await runRawCommand("git", ["remote", "add", "origin", "git@github.com:thehood/mcp-remote-ready.git"], remoteReadyRepoPath);
await runRawCommand("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], remoteReadyRepoPath);
await runRawCommand("git", ["branch", "--set-upstream-to=origin/main", "main"], remoteReadyRepoPath);
const remoteModelAccessPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_model_access",
      arguments: {
        repo_path: remoteReadyRepoPath,
        agents: ["chatgpt-web:chatgpt-pro"],
        purpose: "Remote default review.",
        context_kind: "repo_context"
      }
    }
  }
]);
const remoteModelAccessContent = remoteModelAccessPath[1].result.structuredContent;
assert.equal(remoteModelAccessContent.repo_visibility.default_gate, "user_choice_required");
assert.equal(remoteModelAccessContent.repo_visibility.clean, true);
assert.equal(remoteModelAccessContent.repo_visibility.pushed, true);
assert.equal(remoteModelAccessContent.repo_visibility.remote_refs_available, true);
assert.equal(remoteModelAccessContent.repo_visibility.github_connector_confirmed, false);
assert.equal(remoteModelAccessContent.repo_visibility.github_remote.owner, "thehood");
assert.ok(
  remoteModelAccessContent.repo_visibility.user_choices.some(
    (choice) => choice.id === "confirm_chatgpt_web_github_connector" && choice.recommended === true
  ),
  "clean pushed model access preflight should require connector confirmation before remote refs"
);
assert.ok(
  remoteModelAccessContent.recommended_paths.some(
    (path) => path.id === "confirm_chatgpt_web_github_connector" && path.status === "required_before_remote_default"
  ),
  "clean pushed ChatGPT Web preflight should not default to unconfirmed remote GitHub refs"
);
assert.ok(
  remoteModelAccessContent.destinations.some(
    (destination) =>
      destination.assignment === "chatgpt-web:chatgpt-pro" &&
      destination.remote_repo_access.route === "github_connector" &&
      destination.remote_repo_access.status === "connector_unconfirmed"
  ),
  "clean pushed ChatGPT Web destination should report unconfirmed connector access"
);
assert.ok(
  remoteModelAccessContent.recommended_paths.some((path) => path.id === "approve_local_context_transfer"),
  "unconfirmed remote refs should keep explicit local context approval available"
);

process.env.THEHOOD_CHATGPT_WEB_GITHUB_CONNECTOR_CONFIRMED = "1";
const confirmedRemoteModelAccessPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_model_access",
      arguments: {
        repo_path: remoteReadyRepoPath,
        agents: ["chatgpt-web:chatgpt-pro"],
        purpose: "Confirmed remote default review.",
        context_kind: "repo_context"
      }
    }
  }
]);
process.env.THEHOOD_CHATGPT_WEB_GITHUB_CONNECTOR_CONFIRMED = "0";
const confirmedRemoteModelAccessContent = confirmedRemoteModelAccessPath[1].result.structuredContent;
assert.equal(confirmedRemoteModelAccessContent.repo_visibility.default_gate, "remote_github_refs");
assert.equal(confirmedRemoteModelAccessContent.repo_visibility.github_connector_confirmed, true);
assert.ok(
  confirmedRemoteModelAccessContent.repo_visibility.user_choices.some(
    (choice) => choice.id === "use_remote_github_refs" && choice.recommended === true
  ),
  "confirmed clean pushed model access preflight should recommend remote GitHub refs"
);
assert.ok(
  confirmedRemoteModelAccessContent.recommended_paths.some(
    (path) => path.id === "use_remote_github_refs" && path.status === "default_for_chatgpt_web"
  ),
  "confirmed clean pushed ChatGPT Web preflight should default to remote GitHub refs"
);
assert.ok(
  confirmedRemoteModelAccessContent.destinations.some(
    (destination) =>
      destination.assignment === "chatgpt-web:chatgpt-pro" &&
      destination.remote_repo_access.route === "github_connector" &&
      destination.remote_repo_access.status === "default"
  ),
  "confirmed clean pushed ChatGPT Web destination should use GitHub connector by default"
);
assert.ok(
  !confirmedRemoteModelAccessContent.recommended_paths.some((path) => path.id === "approve_local_context_transfer"),
  "confirmed remote default should not recommend local context approval by default"
);

const agentBoardPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_agent_board",
      arguments: {
        run_id: happyPath[2].result.structuredContent.run_id,
        repo_path: repoPath,
        include_artifact: true
      }
    }
  }
]);
const agentBoardContent = agentBoardPath[1].result.structuredContent;
assert.equal(agentBoardContent.kind, "agent_board");
assert.equal(agentBoardContent.scope, "run");
assert.equal(agentBoardContent.runId, happyPath[2].result.structuredContent.run_id);
assert.ok(agentBoardContent.cards.some((card) => card.role === "orchestrator"));
assert.ok(agentBoardContent.cards.some((card) => card.role === "implementer" && card.permissions.edit === true));
assert.ok(agentBoardContent.notes.some((note) => note.includes("display guidance only")));
assert.equal(agentBoardContent.artifact.surface, "dashboard");
assert.equal(agentBoardContent.artifact.manifest.title, "TheHood Agent Board");
assert.ok(Array.isArray(agentBoardContent.artifact.manifest.blocks));
assert.ok(Array.isArray(agentBoardContent.artifact.snapshot.datasets.agent_cards));
assert.ok(agentBoardContent.artifact.snapshot.datasets.agent_cards.some((row) => row.role === "orchestrator"));

const summonPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_summon",
      arguments: {
        run_id: happyPath[2].result.structuredContent.run_id,
        repo_path: repoPath,
        role: "qa",
        agent: "stub:qa",
        kind: "qa",
        brief: "QA the current run without editing files."
      }
    }
  }
]);
const summonContent = summonPath[1].result.structuredContent;
assert.equal(summonContent.summoned_role, "qa");
assert.equal(summonContent.summoned_agent, "stub:qa");
assert.equal(summonContent.summon_kind, "qa");
assert.equal(summonContent.provider_response_count, 1);
assert.equal(summonContent.provider_responses[0].data.qaResult.verdict, "pass");
assert.equal(summonContent.response_artifact.kind, "agent");

const fanoutPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_fanout",
      arguments: {
        run_id: happyPath[2].result.structuredContent.run_id,
        repo_path: repoPath,
        items: [
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
        ]
      }
    }
  }
]);
const fanoutContent = fanoutPath[1].result.structuredContent;
assert.equal(fanoutContent.fanout_status, "completed");
assert.equal(fanoutContent.bounds.requestedItems, 2);
assert.equal(fanoutContent.bounds.executedItems, 2);
assert.equal(fanoutContent.fanout_artifact.kind, "fanout");
assert.deepEqual(fanoutContent.items.map((item) => item.status), ["completed", "completed"]);
assert.equal(fanoutContent.items[0].response_artifact.kind, "agent");

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
assert.equal(doctorContent.runtime.name, "thehood");
assert.ok(doctorContent.runtime.capabilities.includes("approval_artifact_next_actions"));
assert.ok(doctorContent.runtime.capabilities.includes("protected_integrated_patch_gate"));
assert.ok(doctorContent.runtime.capabilities.includes("cli_artifact_reads"));
assert.ok(doctorContent.runtime.capabilities.includes("approval_phrase_enforcement"));
assert.ok(doctorContent.runtime.capabilities.includes("final_report_artifacts"));
assert.ok(doctorContent.runtime.capabilities.includes("progress_packet_artifacts"));
assert.ok(doctorContent.runtime.capabilities.includes("external_transfer_manifests"));
assert.ok(doctorContent.runtime.capabilities.includes("external_transfer_approval_policy"));
assert.ok(doctorContent.runtime.capabilities.includes("targeted_repo_context_followups"));
assert.ok(doctorContent.runtime.capabilities.includes("planner_reconciliation"));
assert.ok(doctorContent.runtime.capabilities.includes("mcp_final_report_next_action"));
assert.ok(doctorContent.runtime.capabilities.includes("canonical_memory_rehydration"));
assert.ok(doctorContent.runtime.capabilities.includes("provider_directive_ack"));
assert.ok(doctorContent.runtime.capabilities.includes("max_iteration_enforcement"));
assert.ok(doctorContent.runtime.capabilities.includes("validation_command_capture"));
assert.ok(doctorContent.runtime.capabilities.includes("review_routing_policy"));
assert.ok(doctorContent.runtime.capabilities.includes("local_agent_execution_artifacts"));
assert.ok(doctorContent.runtime.capabilities.includes("chatgpt_browser_manager"));
assert.ok(doctorContent.runtime.capabilities.includes("chatgpt_web_bridge_fail_fast"));
assert.ok(doctorContent.runtime.capabilities.includes("chatgpt_web_session_isolation"));
assert.ok(doctorContent.runtime.capabilities.includes("chatgpt_web_auth_readiness"));
assert.ok(doctorContent.runtime.capabilities.includes("branded_tui_shell"));
assert.ok(doctorContent.runtime.capabilities.includes("operator_run_monitor"));
assert.ok(doctorContent.runtime.capabilities.includes("operator_next_actions"));
assert.ok(doctorContent.runtime.capabilities.includes("crew_lane_trail"));
assert.ok(doctorContent.runtime.capabilities.includes("runtime_loop_runner"));
assert.ok(doctorContent.runtime.capabilities.includes("autopilot_approval_policy"));
assert.ok(doctorContent.runtime.capabilities.includes("mcp_autopilot_continue_guidance"));
assert.ok(doctorContent.runtime.capabilities.includes("run_status_insights"));
assert.ok(doctorContent.runtime.capabilities.includes("compact_mcp_host_responses"));
assert.ok(doctorContent.runtime.capabilities.includes("same_run_agent_summons"));
assert.ok(doctorContent.runtime.capabilities.includes("bounded_same_run_fanout"));
assert.ok(doctorContent.runtime.capabilities.includes("multi_model_team_presets"));
assert.ok(doctorContent.runtime.capabilities.includes("loop_recommendation_router"));
assert.ok(doctorContent.runtime.capabilities.includes("codex_loop_plan_artifact"));
assert.ok(doctorContent.runtime.capabilities.includes("provider_model_passthrough"));
assert.ok(doctorContent.runtime.capabilities.includes("model_assisted_qa_tester"));
assert.ok(doctorContent.runtime.capabilities.includes("critic_trigger_artifacts"));
assert.ok(doctorContent.runtime.capabilities.includes("revision_packet_artifacts"));
assert.ok(doctorContent.runtime.capabilities.includes("revision_trail"));
assert.ok(doctorContent.runtime.capabilities.includes("runtime_revision_delegation"));
assert.ok(doctorContent.runtime.capabilities.includes("provider_access_modes"));
assert.ok(doctorContent.runtime.capabilities.includes("mcp_repo_gateway_tools"));
assert.ok(doctorContent.runtime.capabilities.includes("chatgpt_mcp_connector_mode"));
assert.ok(doctorContent.runtime.capabilities.includes("pro_access_preflight"));
assert.ok(doctorContent.runtime.capabilities.includes("model_access_preflight"));
assert.ok(doctorContent.runtime.capabilities.includes("codex_agent_board"));
assert.ok(doctorContent.runtime.capabilities.includes("codex_agent_board_artifact"));
const stubProvider = doctorContent.providers.find((provider) => provider.id === "stub");
assert.equal(stubProvider.implemented, true);
assert.deepEqual(stubProvider.issues, []);
assert.deepEqual(stubProvider.accessModes, ["agent-bridge"]);
const chatGptProvider = doctorContent.providers.find((provider) => provider.id === "chatgpt-web");
assert.ok(chatGptProvider.accessModes.includes("agent-bridge"));
assert.ok(chatGptProvider.accessModes.includes("mcp-connector"));
assert.equal(chatGptProvider.modelPolicy, "passthrough");
const claudeProvider = doctorContent.providers.find((provider) => provider.id === "claude-code");
assert.equal(claudeProvider.modelPolicy, "passthrough");
assert.ok(claudeProvider.models.includes("sonnet"));

const mcpLoopRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-mcp-loop-smoke-"));
await runCommand(["init", "--repo", mcpLoopRepoPath]);
await fs.writeFile(
  path.join(mcpLoopRepoPath, "package.json"),
  JSON.stringify(
    {
      scripts: {
        typecheck: "node -e \"process.stdout.write('mcp loop validation ok\\\\n')\""
      }
    },
    null,
    2
  ),
  "utf8"
);
await runCommand(["approvals", "policy", "set", "mode", "autopilot", "--repo", mcpLoopRepoPath]);
const mcpLoopRun = JSON.parse(
  await runCommand([
    "run",
    "exercise mcp loop runner",
    "--repo",
    mcpLoopRepoPath,
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
);
const mcpLoopPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_loop",
      arguments: {
        run_id: mcpLoopRun.runId,
        repo_path: mcpLoopRepoPath,
        max_cycles: 3
      }
    }
  }
]);
const mcpLoopContent = mcpLoopPath[1].result.structuredContent;
assert.equal(mcpLoopContent.status, "completed");
assert.equal(mcpLoopContent.stop_kind, "terminal");
assert.equal(mcpLoopContent.provider_response_count, 4);
assert.equal(mcpLoopContent.cycles.length, 1);
const mcpAutoLoopPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_orchestrate",
      arguments: {
        goal: "exercise mcp auto loop",
        repo_path: mcpLoopRepoPath,
        mode: "implement",
        role_mapping: {
          orchestrator: "stub:orchestrator",
          implementer: "stub:implementer",
          qa: "stub:qa",
          verifier: "stub:verifier",
          critic: "stub:critic"
        },
        auto_loop: true,
        max_cycles: 3
      }
    }
  }
]);
const mcpAutoLoopContent = mcpAutoLoopPath[1].result.structuredContent;
assert.equal(mcpAutoLoopContent.status, "completed");
assert.equal(mcpAutoLoopContent.stop_kind, "terminal");
assert.equal(mcpAutoLoopContent.provider_response_count, 4);

const reconciliationSeedPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_consult",
      arguments: {
        goal: "create a completed run for reconciliation smoke",
        repo_path: repoPath,
        role: "orchestrator",
        agent: "stub:orchestrator"
      }
    }
  }
]);
const reconciliationSeed = reconciliationSeedPath[1].result.structuredContent;
assert.equal(reconciliationSeed.status, "completed");
assert.ok(
  reconciliationSeed.artifacts.some((artifact) => artifact.kind === "progress"),
  "completed MCP consult should expose a progress packet artifact"
);
assert.ok(
  reconciliationSeed.next_actions.some((action) => action.tool === "thehood_reconcile"),
  "completed MCP consult should suggest reconciliation"
);
const reconciliationSeedTerminalAction = reconciliationSeed.next_actions.find(
  (action) => action.action === "terminal_complete"
);
assert.equal(reconciliationSeedTerminalAction.owner.kind, "runtime");
assert.equal(reconciliationSeedTerminalAction.blocking, false);
assert.ok(reconciliationSeedTerminalAction.generatedAt);
const reconciliationPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_reconcile",
      arguments: {
        run_id: reconciliationSeed.run_id,
        repo_path: repoPath
      }
    }
  }
]);
const reconciliationResult = reconciliationPath[1].result.structuredContent;
assert.equal(reconciliationResult.status, "completed");
assert.equal(reconciliationResult.reconciled_role, "orchestrator");
assert.equal(reconciliationResult.provider_response_count, 1);
assert.equal(reconciliationResult.reconciliation_artifact.kind, "reconciliation");
const reconciliationStatusPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_status",
      arguments: {
        run_id: reconciliationSeed.run_id,
        repo_path: repoPath
      }
    }
  }
]);
assert.equal(
  reconciliationStatusPath[1].result.structuredContent.insights.latestAgentResponse.artifact.kind,
  "reconciliation"
);
assert.equal(
  reconciliationStatusPath[1].result.structuredContent.insights.latestReconciliation.kind,
  "reconciliation"
);
assert.equal(
  reconciliationStatusPath[1].result.structuredContent.insights.canonicalMemory.currentRun.artifacts.latestReconciliation.ref,
  reconciliationResult.reconciliation_artifact.ref
);

const repoTreePath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_repo_tree",
      arguments: {
        repo_path: repoPath,
        max_depth: 3
      }
    }
  }
]);
assert.ok(
  repoTreePath[1].result.structuredContent.entries.some((entry) => entry.path === "README.md"),
  "repo tree should include README.md"
);
assert.ok(
  repoTreePath[1].result.structuredContent.entries.every((entry) => !entry.path.startsWith(".thehood")),
  "repo tree should hide .thehood runtime state"
);

const repoReadPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_repo_read_file",
      arguments: {
        repo_path: repoPath,
        path: "README.md",
        max_bytes: 1000
      }
    }
  }
]);
assert.equal(repoReadPath[1].result.structuredContent.path, "README.md");
assert.ok(repoReadPath[1].result.structuredContent.content.includes("Provider access modes"));

const repoSearchPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_repo_search",
      arguments: {
        repo_path: repoPath,
        query: "mcp-connector",
        globs: ["src/**/*.ts"]
      }
    }
  }
]);
assert.equal(repoSearchPath[1].result.structuredContent.matches[0].path, "src/gateway.ts");
assert.equal(repoSearchPath[1].result.structuredContent.matches[0].line, 1);

const repoStatusPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_git_status",
      arguments: {
        repo_path: repoPath
      }
    }
  }
]);
assert.equal(repoStatusPath[1].result.structuredContent.exitCode, 0);
assert.ok(repoStatusPath[1].result.structuredContent.stdout.includes("README.md"));

const repoDiffPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_git_diff",
      arguments: {
        repo_path: repoPath,
        max_bytes: 4000
      }
    }
  }
]);
assert.equal(repoDiffPath[1].result.structuredContent.exitCode, 0);

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
const assignedPlannerRoster = assignRolesPath[1].result.structuredContent.roster.find(
  (item) => item.role === "planner"
);
assert.equal(assignedPlannerRoster.assignmentLabel, "stub:planner");
assert.equal(assignedPlannerRoster.assignmentSource, "repo_config");
assert.equal(assignedPlannerRoster.readOnly, true);

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
const consultFinalReportArtifact = consultPath[1].result.structuredContent.artifacts.find(
  (artifact) => artifact.kind === "report" && artifact.summary.includes("Final report")
);
assert.ok(consultFinalReportArtifact, "consult should expose final report artifact");
const consultFinalReportAction = consultPath[1].result.structuredContent.next_actions.find(
  (action) => action.action === "inspect_final_report"
);
assert.equal(consultFinalReportAction.tool, "thehood_read_artifact");
assert.equal(consultFinalReportAction.arguments.ref, consultFinalReportArtifact.ref);
assert.deepEqual(consultFinalReportAction.artifactRefs, [consultFinalReportArtifact.ref]);
assert.equal(consultFinalReportAction.owner.kind, "runtime");

const consultStatusPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_status",
      arguments: {
        run_id: consultPath[1].result.structuredContent.run_id,
        repo_path: repoPath
      }
    }
  }
]);
const consultStatus = consultStatusPath[1].result.structuredContent;
assert.equal(consultStatus.agent_board.kind, "agent_board");
assert.equal(consultStatus.agent_board.scope, "run");
assert.ok(
  consultStatus.agent_board.cards.some((card) => card.role === "critic" && card.status === "satisfied"),
  "MCP status should expose a visual-ready critic card for completed review runs"
);
assert.equal(consultStatus.insights.latestAgentResponse.status, "ok");
assert.equal(consultStatus.insights.latestAgentResponse.primaryOutputKey, "critiqueResult");
assert.equal(consultStatus.insights.finalReport.artifact.ref, consultFinalReportArtifact.ref);
assert.equal(consultStatus.insights.latestProgressPacket.kind, "progress");
assert.equal(consultStatus.insights.canonicalMemory.kind, "canonical_memory");
assert.equal(consultStatus.insights.canonicalMemory.artifactBodyPolicy, "refs_only");
assert.equal(consultStatus.insights.revisionTrail.kind, "revision_trail");
assert.ok(Array.isArray(consultStatus.insights.revisionTrail.items));
assert.equal(consultStatus.insights.crewLanes.kind, "crew_lane_trail");
assert.ok(Array.isArray(consultStatus.insights.crewLanes.lanes));
assert.ok(
  consultStatus.insights.crewLanes.lanes.some((lane) => lane.id === "crew-lane-complete"),
  "MCP status insights should expose runtime-derived crew lanes"
);
assert.ok(Array.isArray(consultStatus.insights.operatorNextActions));
assert.ok(
  consultStatus.insights.operatorNextActions.some((nextAction) => nextAction.action === "terminal_complete"),
  "MCP status insights should expose runtime-derived operator next actions"
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
        agent: "claude-code:sonnet"
      }
    }
  }
]);

const fakeClaudeRunId = fakeClaudeConsultGate[1].result.structuredContent.run_id;
const fakeClaudeNextApproval = fakeClaudeConsultGate[1].result.structuredContent.next_actions.find(
  (action) => action.action === "continue_with_approval"
);
assert.equal(fakeClaudeConsultGate[1].result.structuredContent.status, "awaiting_approval");
assert.equal(fakeClaudeConsultGate[1].result.structuredContent.consulted_agent, "claude-code:sonnet");
assert.equal(fakeClaudeNextApproval.tool, "thehood_continue");
assert.equal(fakeClaudeNextApproval.arguments.run_id, fakeClaudeRunId);
assert.equal(fakeClaudeNextApproval.arguments.approval, "approve");
assert.equal(fakeClaudeNextApproval.owner.kind, "runtime");
assert.equal(fakeClaudeNextApproval.required, true);
assert.ok(fakeClaudeNextApproval.arguments.message.includes("invoke claude-code"));
assert.equal(
  fakeClaudeConsultGate[1].result.structuredContent.provider_responses[0].data.critiqueResult.verdict,
  "unclear"
);

const fakeClaudeBadApproval = await runMcp([
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
        message: "I approve without the required provider phrase."
      }
    }
  }
]);
assert.equal(fakeClaudeBadApproval[1].result.isError, true);
assert.ok(fakeClaudeBadApproval[1].result.structuredContent.error.message.includes("invoke claude-code"));

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
    "const args = process.argv.slice(2);",
    "if (args[0] === 'debug' && args[1] === 'models') {",
    "  process.stdout.write(JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' }] }));",
    "  process.exit(0);",
    "}",
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
          qa: "stub:qa",
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
const isolatedProviderInvocationArtifact = isolatedPatchGate.artifacts.find(
  (artifact) => artifact.kind === "provider_invocation"
);
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
assert.ok(isolatedProviderInvocationArtifact, "MCP isolated codex run should expose provider invocation evidence");
assert.equal(isolatedPatchInspection.tool, "thehood_read_artifact");
assert.equal(isolatedPatchInspection.arguments.ref, isolatedDiffArtifact.ref);
assert.equal(isolatedPatchApproval.arguments.run_id, isolatedRunId);
assert.ok(isolatedPatchApproval.arguments.message.includes("apply isolated patch"));
await assert.rejects(fs.access(path.join(isolatedRepoPath, "implemented.txt")));

const isolatedBadApply = await runMcp([
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
        message: "I approve the patch without the phrase."
      }
    }
  }
]);
assert.equal(isolatedBadApply[1].result.isError, true);
assert.ok(isolatedBadApply[1].result.structuredContent.error.message.includes("apply isolated patch"));
await assert.rejects(fs.access(path.join(isolatedRepoPath, "implemented.txt")));

const isolatedPatch = await fs.readFile(isolatedDiffArtifact.ref, "utf8");
assert.ok(isolatedPatch.includes("implemented.txt"));
assert.ok(isolatedPatch.includes("isolated implementation"));
const isolatedCliArtifact = await runCommand([
  "artifact",
  isolatedRunId,
  isolatedDiffArtifact.ref,
  "--repo",
  isolatedRepoPath,
  "--max-bytes",
  "50000"
]);
assert.ok(isolatedCliArtifact.includes("implemented.txt"));
const isolatedCliDiff = await runCommand([
  "diff",
  isolatedRunId,
  "--repo",
  isolatedRepoPath,
  "--max-bytes",
  "50000"
]);
assert.ok(isolatedCliDiff.includes("isolated implementation"));

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
const isolatedFinalReportArtifact = isolatedResult.artifacts.find(
  (artifact) => artifact.kind === "report" && artifact.summary.includes("Final report")
);
assert.ok(isolatedFinalReportArtifact, "isolated patch completion should attach a final report");
const isolatedFinalReportAction = isolatedResult.next_actions.find(
  (action) => action.action === "inspect_final_report"
);
assert.equal(isolatedFinalReportAction.tool, "thehood_read_artifact");
assert.equal(isolatedFinalReportAction.arguments.ref, isolatedFinalReportArtifact.ref);

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

const autopilotIsolatedRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "thehood-mcp-autopilot-isolated-"));
await runRawCommand("git", ["init"], autopilotIsolatedRepoPath);
await fs.writeFile(path.join(autopilotIsolatedRepoPath, "README.md"), "# Autopilot Isolated Smoke\n", "utf8");
await runRawCommand("git", ["add", "README.md"], autopilotIsolatedRepoPath);
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
  autopilotIsolatedRepoPath
);
await runCommand(["init", "--repo", autopilotIsolatedRepoPath]);
await runCommand(["approvals", "policy", "set", "mode", "autopilot", "--repo", autopilotIsolatedRepoPath]);
const autopilotIsolatedPath = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_orchestrate",
      arguments: {
        goal: "exercise autopilot isolated patch integration",
        repo_path: autopilotIsolatedRepoPath,
        mode: "implement",
        role_mapping: {
          orchestrator: "stub:orchestrator",
          implementer: "codex-cli:default",
          qa: "stub:qa",
          verifier: "stub:verifier",
          critic: "stub:critic"
        },
        auto_loop: true,
        max_cycles: 3
      }
    }
  }
]);
const autopilotIsolatedContent = autopilotIsolatedPath[1].result.structuredContent;
const autopilotIsolatedRunId = autopilotIsolatedContent.run_id;
const autopilotIsolatedStatus = JSON.parse(
  await runCommand(["status", autopilotIsolatedRunId, "--repo", autopilotIsolatedRepoPath, "--json"])
);

assert.equal(autopilotIsolatedContent.status, "completed");
assert.equal(autopilotIsolatedContent.stop_kind, "terminal");
assert.equal(await fs.readFile(path.join(autopilotIsolatedRepoPath, "implemented.txt"), "utf8"), "isolated implementation\n");
assert.ok(
  autopilotIsolatedStatus.events.some(
    (event) =>
      event.type === "approval_auto_approved" &&
      event.data?.gate === "isolated_patch_application" &&
      typeof event.data?.artifactRef === "string"
  ),
  "autopilot should auto-approve isolated patch application with an artifact ref"
);
assert.ok(
  autopilotIsolatedStatus.events.some((event) => event.type === "patch_applied"),
  "autopilot isolated patch should be applied before completion"
);

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
    "const args = process.argv.slice(2);",
    "if (args[0] === 'debug' && args[1] === 'models') {",
    "  process.stdout.write(JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' }] }));",
    "  process.exit(0);",
    "}",
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
          qa: "stub:qa",
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

const protectedBadVerification = await runMcp([
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
        message: "I approve verification without the phrase."
      }
    }
  }
]);
assert.equal(protectedBadVerification[1].result.isError, true);
assert.ok(protectedBadVerification[1].result.structuredContent.error.message.includes("protected test changes"));

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
assert.ok(
  protectedVerificationResult.provider_responses.some((response) => response.data.critiqueResult?.verdict === "acceptable"),
  "protected verification risk should trigger critic response"
);
assert.ok(protectedVerificationResult.approval_reason.includes("Verifier returned ask_user"));
assert.ok(
  protectedVerificationResult.artifacts.some((artifact) => artifact.kind === "critic_trigger"),
  "protected verification risk should attach a critic trigger artifact"
);

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
          qa: "stub:qa",
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
assert.equal(loopContinue[1].result.structuredContent.provider_response_count, 4);
assert.equal(loopContinue[1].result.structuredContent.provider_responses.at(-1).data.verificationResult.verdict, "approve");
const loopReviewRoutingArtifact = loopContinue[1].result.structuredContent.artifacts.find(
  (artifact) => artifact.kind === "review_routing"
);
assert.ok(loopReviewRoutingArtifact, "MCP loop result should include review routing artifact evidence");
const loopRoutingStatus = await runMcp([
  ...baseMessages,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "thehood_status",
      arguments: {
        run_id: loopRunId,
        repo_path: loopRepoPath
      }
    }
  }
]);
assert.equal(loopRoutingStatus[1].result.structuredContent.insights.latestReviewRouting.riskTier, "medium");
assert.equal(loopRoutingStatus[1].result.structuredContent.insights.latestReviewRouting.required.qa, true);
assert.equal(loopRoutingStatus[1].result.structuredContent.insights.latestReviewRouting.required.verifier, true);

process.stdout.write(`MCP smoke passed using ${repoPath}\n`);
