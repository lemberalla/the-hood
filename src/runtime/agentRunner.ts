import { writeRunArtifact } from "./artifacts.js";
import { buildAgentDirective } from "./directives.js";
import { newId, nowIso } from "./ids.js";
import { getProviderAdapter } from "../providers/router.js";
import { validateAgentResponse } from "./responseContracts.js";
import { loadRun, saveRun } from "./store.js";
import type { AgentResponse } from "../providers/types.js";
import type {
  JsonObject,
  RoleAssignment,
  RunArtifact,
  RunArtifactKind,
  RunEvent,
  RunRecord,
  RuntimeRole
} from "./types.js";

export interface RunAgentOptions {
  assignment?: RoleAssignment;
  responseArtifactKind?: RunArtifactKind;
  responseArtifactNamePrefix?: string;
  responseArtifactSummary?: (response: AgentResponse) => string;
  responseEventType?: string;
}

export interface RunAgentResult {
  run: RunRecord;
  response: AgentResponse;
  directiveArtifact: RunArtifact;
  responseArtifact: RunArtifact;
}

const createEvent = (type: string, message: string, data?: JsonObject): RunEvent => ({
  id: newId("event"),
  createdAt: nowIso(),
  type,
  message,
  ...(data ? { data } : {})
});

export const requiredAssignment = (run: RunRecord, role: RuntimeRole): RoleAssignment => {
  const assignment = run.roleMapping[role];

  if (!assignment) {
    throw new Error(`Run ${run.runId} does not have a ${role} role assignment.`);
  }

  return assignment;
};

const defaultResponseArtifactKind = (role: RuntimeRole): RunArtifactKind =>
  role === "orchestrator" || role === "planner" ? "plan" : "agent";

export const runAgent = async (
  run: RunRecord,
  role: RuntimeRole,
  context: JsonObject,
  options: RunAgentOptions = {}
): Promise<RunAgentResult> => {
  const assignment = options.assignment ?? requiredAssignment(run, role);
  const adapter = getProviderAdapter(assignment);
  const callId = newId("response");
  const directive = await buildAgentDirective(run, role, assignment, context);
  const directiveArtifact = await writeRunArtifact({
    repoPath: run.repoPath,
    runId: run.runId,
    kind: "directive",
    name: `${role}-${callId}-directive.json`,
    content: `${JSON.stringify(directive, null, 2)}\n`,
    summary: `${role} directive for ${assignment.provider}:${assignment.model}`
  });
  const runWithDirective: RunRecord = {
    ...run,
    updatedAt: nowIso(),
    artifacts: [...run.artifacts, directiveArtifact],
    events: [
      ...run.events,
      createEvent("agent_directive_created", `${role} directive created.`, {
        role,
        provider: assignment.provider,
        model: assignment.model,
        outputContract: directive.outputContract.name,
        artifactRef: directiveArtifact.ref
      })
    ]
  };

  await saveRun(runWithDirective);

  const response = await adapter.runAgent({
    run: runWithDirective,
    role,
    assignment,
    context,
    directive
  });
  validateAgentResponse(role, directive, response);

  const responseArtifactKind = options.responseArtifactKind ?? defaultResponseArtifactKind(role);
  const artifact = await writeRunArtifact({
    repoPath: runWithDirective.repoPath,
    runId: runWithDirective.runId,
    kind: responseArtifactKind,
    name: `${options.responseArtifactNamePrefix ?? role}-${callId}-response.json`,
    content: `${JSON.stringify(response, null, 2)}\n`,
    summary: options.responseArtifactSummary?.(response) ?? `${role} response: ${response.summary}`
  });
  const latestRun = await loadRun(runWithDirective.repoPath, runWithDirective.runId);
  const updated: RunRecord = {
    ...latestRun,
    updatedAt: nowIso(),
    artifacts: [...latestRun.artifacts, artifact],
    events: [
      ...latestRun.events,
      createEvent(options.responseEventType ?? "agent_response", `${role} responded: ${response.summary}`, {
        role,
        provider: assignment.provider,
        model: assignment.model,
        status: response.status,
        artifactRef: artifact.ref
      })
    ]
  };

  await saveRun(updated);

  return {
    run: updated,
    response,
    directiveArtifact,
    responseArtifact: artifact
  };
};
