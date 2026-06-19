import type { AgentResponse } from "../providers/types.js";
import { InputError } from "./errors.js";
import { advanceRun } from "./loop.js";
import type { RunRecord, RunState } from "./types.js";

export interface RunLoopInput {
  repoPath: string;
  runId: string;
  maxCycles?: number;
  maxStepsPerCycle?: number;
}

export type RunLoopStopKind =
  | "terminal"
  | "approval_required"
  | "no_progress"
  | "max_cycles";

export interface RunLoopCycle {
  cycle: number;
  state: RunState;
  advanced: boolean;
  approvalRequired: boolean;
  stopReason: string;
  providerResponseCount: number;
}

export interface RunLoopResult {
  run: RunRecord;
  advanced: boolean;
  stopKind: RunLoopStopKind;
  stopReason: string;
  cycles: RunLoopCycle[];
  maxCycles: number;
  maxStepsPerCycle: number;
  providerResponses: AgentResponse[];
}

const terminalStates = new Set<RunState>(["completed", "failed", "aborted"]);

const positiveInteger = (value: number | undefined, fallback: number, label: string): number => {
  const candidate = value ?? fallback;

  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new InputError(`${label} must be a positive integer.`);
  }

  return candidate;
};

const stopKindForRun = (run: RunRecord, advanced: boolean, reachedCycleLimit: boolean): RunLoopStopKind => {
  if (terminalStates.has(run.state)) {
    return "terminal";
  }

  if (run.approvalRequired) {
    return "approval_required";
  }

  if (!advanced) {
    return "no_progress";
  }

  return reachedCycleLimit ? "max_cycles" : "no_progress";
};

const stopReasonForKind = (
  kind: RunLoopStopKind,
  run: RunRecord,
  lastStopReason: string,
  maxCycles: number
): string => {
  if (kind === "terminal") {
    return run.stopReason ?? lastStopReason;
  }

  if (kind === "max_cycles") {
    return `Loop cycle cap reached (${maxCycles}). Last stop reason: ${lastStopReason}`;
  }

  return lastStopReason;
};

export const runAutopilotLoop = async (input: RunLoopInput): Promise<RunLoopResult> => {
  const maxCycles = positiveInteger(input.maxCycles, 8, "maxCycles");
  const maxStepsPerCycle = positiveInteger(input.maxStepsPerCycle, 10, "maxStepsPerCycle");
  const cycles: RunLoopCycle[] = [];
  const providerResponses: AgentResponse[] = [];
  let run: RunRecord | undefined;
  let advanced = false;
  let lastStopReason = "No loop cycle ran.";

  for (let index = 0; index < maxCycles; index += 1) {
    const result = await advanceRun({
      repoPath: input.repoPath,
      runId: input.runId,
      maxSteps: maxStepsPerCycle
    });

    run = result.run;
    advanced = advanced || result.advanced;
    lastStopReason = result.stopReason;
    providerResponses.push(...result.providerResponses);
    cycles.push({
      cycle: index + 1,
      state: result.run.state,
      advanced: result.advanced,
      approvalRequired: result.run.approvalRequired,
      stopReason: result.stopReason,
      providerResponseCount: result.providerResponses.length
    });

    if (terminalStates.has(result.run.state) || result.run.approvalRequired || !result.advanced) {
      break;
    }
  }

  if (!run) {
    throw new InputError("Loop did not load a run.");
  }

  const reachedCycleLimit = cycles.length >= maxCycles &&
    !terminalStates.has(run.state) &&
    !run.approvalRequired &&
    cycles.at(-1)?.advanced === true;
  const stopKind = stopKindForRun(run, cycles.at(-1)?.advanced === true, reachedCycleLimit);

  return {
    run,
    advanced,
    stopKind,
    stopReason: stopReasonForKind(stopKind, run, lastStopReason, maxCycles),
    cycles,
    maxCycles,
    maxStepsPerCycle,
    providerResponses
  };
};
