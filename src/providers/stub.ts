import type { AgentRequest, AgentResponse, ProviderAdapter } from "./types.js";

const response = (summary: string, data: AgentResponse["data"]): AgentResponse => ({
  status: "ok",
  summary,
  data
});

const orchestratorResponse = (request: AgentRequest): AgentResponse =>
  response("Stub orchestrator created a deterministic delegation plan.", {
    decision: {
      action: request.run.mode === "implement" ? "delegate" : "complete",
      reason: "Stub provider is exercising the loop without external model calls.",
      nextRole: request.run.mode === "implement" ? "implementer" : null,
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

const implementerResponse = (): AgentResponse =>
  response("Stub implementer performed no file edits.", {
    implementationResult: {
      status: "no_change",
      changedFiles: [],
      commandsRun: [],
      unresolvedRisks: []
    }
  });

const verifierResponse = (request: AgentRequest): AgentResponse => {
  const protectedChangeCount = Number(request.context.protectedChangeCount ?? 0);
  const verdict = protectedChangeCount > 0 ? "ask_user" : "approve";

  return response(`Stub verifier returned ${verdict}.`, {
    verificationResult: {
      verdict,
      summary:
        protectedChangeCount > 0
          ? "Protected files changed; user approval is required."
          : "No protected changes were detected in runtime evidence.",
      failedCriteria: [],
      risks: protectedChangeCount > 0 ? ["Protected path changes need explicit review."] : [],
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
        return implementerResponse();
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
