import type { AgentRequest, AgentResponse, ProviderAdapter } from "./types.js";

const response = (summary: string, data: AgentResponse["data"]): AgentResponse => ({
  status: "ok",
  summary,
  data
});

const hasRepoContext = (request: AgentRequest): boolean =>
  request.context.repoContext !== undefined || request.context.repoContextArtifact !== undefined;

const shouldExerciseRepoContext = (request: AgentRequest): boolean =>
  request.run.mode === "plan" && request.run.userGoal.includes("repo-context-smoke");

const shouldExerciseRoleDelegate = (request: AgentRequest): boolean =>
  request.run.mode === "plan" && request.run.userGoal.includes("role-delegate-smoke");

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasRevisionPacket = (request: AgentRequest): boolean =>
  isJsonObject(request.context.latestRevisionPacket);

const shouldExerciseQaRevisionLoop = (request: AgentRequest): boolean =>
  request.run.mode === "implement" && request.run.userGoal.includes("qa-revision-loop-smoke");

const shouldExerciseVerifierRevisionLoop = (request: AgentRequest): boolean =>
  request.run.mode === "implement" && request.run.userGoal.includes("verifier-revision-loop-smoke");

const orchestratorResponse = (request: AgentRequest): AgentResponse => {
  if (shouldExerciseRepoContext(request) && !hasRepoContext(request)) {
    return response("Stub orchestrator requested deterministic repo context.", {
      decision: {
        action: "delegate",
        reason: "Stub provider is exercising repo context capture before planning.",
        delegate: {
          role: "repo_reader",
          task: "Capture bounded repository context for planning."
        }
      }
    });
  }

  if (shouldExerciseRoleDelegate(request)) {
    return response("Stub orchestrator delegated a ready implementation slice.", {
      decision: {
        action: "delegate",
        reason: "Planning is complete; this slice is ready for implementation.",
        delegateTo: "implementer",
        sliceName: "role-delegate-smoke-ready-slice",
        requiresMoreEvidence: false,
        requiresUserApproval: false
      },
      acceptanceCriteria: [
        "Plan runs complete after a ready implementer handoff.",
        "Repo context is not recaptured for implementation handoffs."
      ]
    });
  }

  return response("Stub orchestrator created a deterministic delegation plan.", {
    decision: {
      action: request.run.mode === "implement" ? "delegate" : "complete",
      reason: hasRepoContext(request)
        ? "Stub provider received runtime repo context and completed planning."
        : "Stub provider is exercising the loop without external model calls.",
      nextRole: request.run.mode === "implement" ? "implementer" : null
    },
    plan: [
      "Capture baseline evidence.",
      "Run scoped implementer.",
      "Capture post-work evidence.",
      "Ask independent verifier for a verdict."
    ],
    acceptanceCriteria: [
      "Runtime state advances without bypassing approval gates.",
      "Verifier remains separate from implementer.",
      "Evidence artifacts are available for inspection."
    ]
  });
};

const researcherResponse = (): AgentResponse =>
  response("Stub researcher returned deterministic findings.", {
    researchResult: {
      summary: "Stub research completed without external calls.",
      findings: [
        "Runtime can dispatch a read-only research role.",
        "Research output is schema-bound before state advances."
      ],
      openQuestions: []
    }
  });

const implementerResponse = (request: AgentRequest): AgentResponse =>
  response(hasRevisionPacket(request)
    ? "Stub implementer handled the runtime revision packet."
    : "Stub implementer performed no file edits.", {
    implementationResult: {
      status: "no_change",
      changedFiles: [],
      commandsRun: [],
      unresolvedRisks: []
    }
  });

const qaResponse = (request: AgentRequest): AgentResponse => {
  if (shouldExerciseQaRevisionLoop(request) && !hasRevisionPacket(request)) {
    return response("Stub QA tester requested a repair loop.", {
      qaResult: {
        verdict: "needs_revision",
        summary: "QA found a deterministic missed-case marker for the repair loop smoke.",
        suggestedCommands: ["npm run smoke:runtime"],
        risks: ["The first pass intentionally needs a repair delegation."]
      }
    });
  }

  return response("Stub QA tester found no missing validation concerns.", {
    qaResult: {
      verdict: "pass",
      summary: "Stub QA tester reviewed available evidence and found no extra concerns.",
      suggestedCommands: [],
      risks: []
    }
  });
};

const verifierResponse = (request: AgentRequest): AgentResponse => {
  const protectedChangeCount = Number(request.context.protectedChangeCount ?? 0);
  const validationFailureCount = Number(request.context.validationFailureCount ?? 0);
  const exerciseVerifierRevision = shouldExerciseVerifierRevisionLoop(request) && !hasRevisionPacket(request);
  const verdict = exerciseVerifierRevision
    ? "revise"
    : protectedChangeCount > 0 || validationFailureCount > 0 ? "ask_user" : "approve";

  return response(`Stub verifier returned ${verdict}.`, {
    verificationResult: {
      verdict,
      summary:
        exerciseVerifierRevision
          ? "Verifier found a deterministic repair-loop marker."
          : protectedChangeCount > 0
          ? "Protected files changed; user approval is required."
          : validationFailureCount > 0
            ? "Runtime validation commands failed; user review is required."
          : "No protected changes were detected in runtime evidence.",
      failedCriteria: exerciseVerifierRevision ? ["Repair-loop verifier criterion was not satisfied on first pass."] : [],
      risks: [
        ...(exerciseVerifierRevision ? ["The first verifier pass intentionally needs a repair delegation."] : []),
        ...(protectedChangeCount > 0 ? ["Protected path changes need explicit review."] : []),
        ...(validationFailureCount > 0 ? ["Runtime validation command failures need review."] : [])
      ],
      nextAction: verdict === "approve" ? "complete" : "ask_user"
    }
  });
};
export const stubProvider: ProviderAdapter = {
  id: "stub",
  async runAgent(request) {
    switch (request.role) {
      case "orchestrator":
      case "planner":
        return orchestratorResponse(request);
      case "researcher":
        return researcherResponse();
      case "implementer":
        return implementerResponse(request);
      case "qa":
        return qaResponse(request);
      case "verifier":
        return verifierResponse(request);
      case "critic":
        return response("Stub critic found no blocking concerns.", {
          critiqueResult: {
            verdict: "acceptable",
            blockingConcerns: [],
            nonBlockingConcerns: []
          }
        });
      default:
        return response(`Stub ${request.role} completed.`, {
          role: request.role
        });
    }
  }
};
