import type { RoleRosterItem } from "./roleRoster.js";
import type { RunInsights } from "./runInsights.js";
import type {
  CrewLane,
  LoopResponsibility,
  OperatorNextAction,
  ReviewLane,
  RuntimeRole,
  RunRecord
} from "./types.js";

export type AgentBoardScope = "repo" | "run";
export type AgentBoardCardStatus =
  | "active"
  | "blocked"
  | "ready"
  | "satisfied"
  | "pending"
  | "skipped"
  | "advisory"
  | "unassigned"
  | "needs_attention";

export interface AgentBoardCard {
  id: string;
  role: RuntimeRole;
  laneLabel: string;
  title: string;
  assignmentLabel: string;
  assignmentSource: RoleRosterItem["assignmentSource"];
  readiness: RoleRosterItem["state"];
  status: AgentBoardCardStatus;
  authority: RoleRosterItem["authority"];
  readOnly: boolean;
  permissions: RoleRosterItem["permissions"];
  responsibility: string;
  issues: string[];
  provider?: string;
  model?: string;
  run?: {
    runId: string;
    state: RunRecord["state"];
    mode: RunRecord["mode"];
    currentLane?: string;
    laneStatus?: string;
    laneSummary?: string;
    required?: boolean;
    blocking?: boolean;
    canSatisfyGate?: boolean;
    satisfiesRequired?: boolean;
    sidecarOnly?: boolean;
    artifactRefs: string[];
    eventRefs: string[];
    handoffRefs: string[];
  };
}

export interface AgentBoardAction {
  action: OperatorNextAction["action"];
  label: string;
  ownerLabel: string;
  role?: RuntimeRole;
  blocking: boolean;
  required: boolean;
  state: string;
  description: string;
  commandHint?: string;
  mcpToolHint?: string;
  tool?: string;
  artifactRefs: string[];
  eventRefs: string[];
}

export interface AgentBoard {
  schemaVersion: 1;
  kind: "agent_board";
  scope: AgentBoardScope;
  repoPath: string;
  runId?: string;
  runState?: RunRecord["state"];
  runMode?: RunRecord["mode"];
  summary: {
    total: number;
    ready: number;
    active: number;
    blocked: number;
    unassigned: number;
    needsAttention: number;
  };
  cards: AgentBoardCard[];
  actions: AgentBoardAction[];
  notes: string[];
}

const roleTitles: Record<RuntimeRole, string> = {
  orchestrator: "Orchestrator",
  planner: "Planner",
  researcher: "Researcher",
  implementer: "Implementer",
  qa: "QA Tester",
  verifier: "Verifier",
  critic: "Critic",
  integrator: "Integrator",
  citation: "Citation Agent"
};

const roleFromLane = (lane: CrewLane | LoopResponsibility | ReviewLane): RuntimeRole | undefined =>
  ("role" in lane ? lane.role : undefined) ?? lane.owner.role;

const latestByRole = <T extends CrewLane | LoopResponsibility | ReviewLane>(
  items: T[]
): Map<RuntimeRole, T> => {
  const result = new Map<RuntimeRole, T>();

  for (const item of items) {
    const role = roleFromLane(item);
    if (role) {
      result.set(role, item);
    }
  }

  return result;
};

const statusFromRunLane = (
  lane: CrewLane | LoopResponsibility | ReviewLane | undefined,
  run: RunRecord | undefined
): AgentBoardCardStatus | undefined => {
  if (!lane || !run) {
    return undefined;
  }
  const status = laneStatus(lane);

  if (laneBlocking(lane) || status === "blocked" || status === "failed" || status === "needs_revision") {
    return "blocked";
  }

  if (status === "in_progress" || (status === "ready" && run.state !== "completed")) {
    return "active";
  }

  if (status === "satisfied") {
    return "satisfied";
  }

  if (status === "skipped") {
    return "skipped";
  }

  if (status === "advisory") {
    return "advisory";
  }

  if (status === "pending") {
    return "pending";
  }

  return "ready";
};

const statusFromRoster = (item: RoleRosterItem): AgentBoardCardStatus => {
  if (item.state === "unassigned") {
    return "unassigned";
  }

  if (item.state === "needs_attention") {
    return "needs_attention";
  }

  return "ready";
};

const unique = (values: string[]): string[] =>
  [...new Set(values.filter((value) => value.trim().length > 0))];

const runLaneForRole = (
  role: RuntimeRole,
  insights: RunInsights | undefined
): CrewLane | LoopResponsibility | ReviewLane | undefined => {
  if (!insights) {
    return undefined;
  }

  return (
    latestByRole(insights.crewLanes.lanes).get(role) ??
    latestByRole(insights.reviewLanes).get(role) ??
    latestByRole(insights.loopResponsibilities.responsibilities).get(role)
  );
};

const artifactRefsForLane = (lane: CrewLane | LoopResponsibility | ReviewLane | undefined): string[] =>
  lane ? unique(lane.artifactRefs) : [];

const eventRefsForLane = (lane: CrewLane | LoopResponsibility | ReviewLane | undefined): string[] =>
  lane ? unique(lane.eventRefs) : [];

const handoffRefsForLane = (lane: CrewLane | LoopResponsibility | ReviewLane | undefined): string[] =>
  lane && "handoffRefs" in lane ? unique(lane.handoffRefs) : [];

const laneSummary = (lane: CrewLane | LoopResponsibility | ReviewLane | undefined): string | undefined =>
  lane && "summary" in lane ? lane.summary : lane?.reason;

const laneStatus = (lane: CrewLane | LoopResponsibility | ReviewLane): CrewLane["status"] | ReviewLane["state"] =>
  "status" in lane ? lane.status : lane.state;

const laneBlocking = (lane: CrewLane | LoopResponsibility | ReviewLane): boolean =>
  "blocking" in lane
    ? lane.blocking
    : lane.required && ["pending", "blocked", "failed", "needs_revision"].includes(lane.state);

const laneCanSatisfyGate = (lane: CrewLane | LoopResponsibility | ReviewLane): boolean =>
  "canSatisfyGate" in lane ? lane.canSatisfyGate : lane.canSatisfyRequired;

const laneSatisfiesRequired = (lane: CrewLane | LoopResponsibility | ReviewLane): boolean | undefined =>
  "satisfiesRequired" in lane ? lane.satisfiesRequired : undefined;

const laneSidecarOnly = (lane: CrewLane | LoopResponsibility | ReviewLane): boolean =>
  ("sidecarOnly" in lane && lane.sidecarOnly === true) || ("sourceKind" in lane && lane.sourceKind === "summon_evidence");

const buildCard = (
  item: RoleRosterItem,
  run: RunRecord | undefined,
  insights: RunInsights | undefined
): AgentBoardCard => {
  const lane = runLaneForRole(item.role, insights);
  const runStatus = statusFromRunLane(lane, run);
  const summary = laneSummary(lane);
  const satisfiesRequired = lane ? laneSatisfiesRequired(lane) : undefined;

  return {
    id: `agent-card-${item.role}`,
    role: item.role,
    laneLabel: item.laneLabel,
    title: roleTitles[item.role],
    assignmentLabel: item.assignmentLabel,
    assignmentSource: item.assignmentSource,
    readiness: item.state,
    status: runStatus ?? statusFromRoster(item),
    authority: item.authority,
    readOnly: item.readOnly,
    permissions: item.permissions,
    responsibility: item.responsibility,
    issues: item.issues,
    ...(item.assignment
      ? {
          provider: item.assignment.provider,
          model: item.assignment.model
        }
      : {}),
    ...(run && lane
      ? {
          run: {
            runId: run.runId,
            state: run.state,
            mode: run.mode,
            currentLane: lane.label,
            laneStatus: laneStatus(lane),
            ...(summary ? { laneSummary: summary } : {}),
            required: lane.required,
            blocking: laneBlocking(lane),
            canSatisfyGate: laneCanSatisfyGate(lane),
            ...(satisfiesRequired === undefined ? {} : { satisfiesRequired }),
            ...(laneSidecarOnly(lane) ? { sidecarOnly: true } : {}),
            artifactRefs: artifactRefsForLane(lane),
            eventRefs: eventRefsForLane(lane),
            handoffRefs: handoffRefsForLane(lane)
          }
        }
      : {})
  };
};

const actionOwner = (action: OperatorNextAction): string =>
  action.owner.role ? `${action.owner.label} (${action.owner.role})` : action.owner.label;

const boardActions = (insights: RunInsights | undefined): AgentBoardAction[] =>
  (insights?.operatorNextActions ?? []).slice(0, 6).map((action) => ({
    action: action.action,
    label: action.label,
    ownerLabel: actionOwner(action),
    ...(action.owner.role ? { role: action.owner.role } : {}),
    blocking: action.blocking,
    required: action.required,
    state: action.state,
    description: action.description,
    ...(action.commandHint ? { commandHint: action.commandHint } : {}),
    ...(action.mcpToolHint ? { mcpToolHint: action.mcpToolHint } : {}),
    ...(action.tool ? { tool: action.tool } : {}),
    artifactRefs: action.artifactRefs,
    eventRefs: action.eventRefs
  }));

const countStatus = (cards: AgentBoardCard[], status: AgentBoardCardStatus): number =>
  cards.filter((card) => card.status === status).length;

export const buildAgentBoard = (
  input: {
    repoPath: string;
    roster: RoleRosterItem[];
    run?: RunRecord;
    insights?: RunInsights;
  }
): AgentBoard => {
  const cards = input.roster.map((item) => buildCard(item, input.run, input.insights));
  const notes = [
    "Agent cards are derived from runtime role config, health, crew lanes, review lanes, handoffs, and artifacts.",
    "Cards are display guidance only; they do not grant tools, schedule agents, satisfy gates, or approve work."
  ];

  return {
    schemaVersion: 1,
    kind: "agent_board",
    scope: input.run ? "run" : "repo",
    repoPath: input.repoPath,
    ...(input.run ? { runId: input.run.runId, runState: input.run.state, runMode: input.run.mode } : {}),
    summary: {
      total: cards.length,
      ready: countStatus(cards, "ready") + countStatus(cards, "satisfied"),
      active: countStatus(cards, "active"),
      blocked: countStatus(cards, "blocked"),
      unassigned: countStatus(cards, "unassigned"),
      needsAttention: countStatus(cards, "needs_attention")
    },
    cards,
    actions: boardActions(input.insights),
    notes
  };
};
