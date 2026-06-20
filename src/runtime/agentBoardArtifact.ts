import type { AgentBoard, AgentBoardAction, AgentBoardCard } from "./agentBoard.js";
import type { JsonObject, JsonValue } from "./types.js";

export interface AgentBoardArtifact {
  surface: "dashboard";
  manifest: JsonObject;
  snapshot: JsonObject;
  sources: [];
}

const runtimeSource = (): JsonObject => ({
  id: "agent_board_runtime",
  label: "TheHood runtime agent board",
  query: {
    language: "thehood-runtime",
    description: "Runtime-derived role, lane, and evidence snapshot from TheHood agentBoard.",
    sql: "SELECT * FROM thehood_agent_board_snapshot",
    tables_used: ["thehood_agent_board_snapshot"]
  }
});

const joinList = (values: string[]): string =>
  values.length > 0 ? values.join(", ") : "";

const permissions = (card: AgentBoardCard): string =>
  [
    card.permissions.read ? "read" : "",
    card.permissions.edit ? "edit" : "",
    card.permissions.shell ? "shell" : "",
    card.permissions.network ? "network" : ""
  ].filter(Boolean).join(", ");

const cardRow = (card: AgentBoardCard): JsonObject => ({
  role: card.role,
  laneLabel: card.laneLabel,
  title: card.title,
  owner: card.assignmentLabel,
  status: card.status,
  readiness: card.readiness,
  authority: card.readOnly ? "read-only" : "edit-capable",
  permissions: permissions(card),
  runLane: card.run?.currentLane ?? "",
  laneStatus: card.run?.laneStatus ?? "",
  blocking: card.run?.blocking === true,
  sidecarOnly: card.run?.sidecarOnly === true,
  canSatisfyGate: card.run?.canSatisfyGate === true,
  satisfiesRequired: card.run?.satisfiesRequired === true,
  evidenceRefs: joinList(card.run?.artifactRefs ?? []),
  eventRefs: joinList(card.run?.eventRefs ?? []),
  issues: joinList(card.issues),
  responsibility: card.responsibility
});

const actionRow = (action: AgentBoardAction): JsonObject => ({
  action: action.action,
  label: action.label,
  owner: action.ownerLabel,
  role: action.role ?? "",
  blocking: action.blocking,
  required: action.required,
  state: action.state,
  tool: action.tool ?? "",
  commandHint: action.commandHint ?? "",
  artifactRefs: joinList(action.artifactRefs),
  description: action.description
});

const tableSource = (): JsonObject => ({
  source: runtimeSource()
});

const agentCardsTable = (): JsonObject => ({
  id: "agent_cards",
  title: "Agent Cards",
  dataset: "agent_cards",
  ...tableSource(),
  columns: [
    { field: "laneLabel", header: "Lane" },
    { field: "owner", header: "Owner" },
    { field: "status", header: "Status" },
    { field: "authority", header: "Authority" },
    { field: "runLane", header: "Run Lane" },
    { field: "blocking", header: "Blocking" },
    { field: "evidenceRefs", header: "Evidence" }
  ],
  defaultSort: {
    field: "laneLabel",
    direction: "asc"
  }
});

const actionsTable = (): JsonObject => ({
  id: "next_actions",
  title: "Next Actions",
  dataset: "next_actions",
  ...tableSource(),
  columns: [
    { field: "action", header: "Action" },
    { field: "owner", header: "Owner" },
    { field: "blocking", header: "Blocking" },
    { field: "required", header: "Required" },
    { field: "tool", header: "MCP Tool" },
    { field: "description", header: "Description" }
  ],
  defaultSort: {
    field: "blocking",
    direction: "desc"
  }
});

const markdown = (board: AgentBoard): string =>
  [
    "# TheHood Agent Board",
    board.runId
      ? `Run ${board.runId} is ${board.runState ?? "unknown"}${board.runMode ? ` in ${board.runMode} mode` : ""}.`
      : "Repo-scoped configured agent visibility.",
    "",
    "Runtime-derived display only. Cards do not grant tools, schedule agents, satisfy gates, or approve work."
  ].join("\n");

const manifest = (board: AgentBoard): JsonObject => {
  const blocks: JsonObject[] = [
    {
      id: "intro",
      type: "markdown",
      body: markdown(board)
    },
    {
      id: "summary",
      type: "metric-strip",
      cardIds: ["summary_cards"]
    },
    {
      id: "agent_cards",
      type: "table",
      tableId: "agent_cards"
    }
  ];
  const tables: JsonObject[] = [agentCardsTable()];

  if (board.actions.length > 0) {
    blocks.push({
      id: "next_actions",
      type: "table",
      tableId: "next_actions"
    });
    tables.push(actionsTable());
  }

  return {
    version: 1,
    surface: "dashboard",
    title: "TheHood Agent Board",
    description: "Runtime-derived agent visibility for TheHood.",
    blocks,
    cards: [
      {
        id: "summary_cards",
        dataset: "summary_metrics",
        metrics: [
          { label: "Ready", field: "ready" },
          { label: "Active", field: "active" },
          { label: "Blocked", field: "blocked" },
          { label: "Unassigned", field: "unassigned" }
        ]
      }
    ],
    tables
  };
};

const snapshot = (board: AgentBoard): JsonObject => ({
  version: 1,
  status: "ready",
  datasets: {
    summary_metrics: [
      {
        total: board.summary.total,
        ready: board.summary.ready,
        active: board.summary.active,
        blocked: board.summary.blocked,
        unassigned: board.summary.unassigned,
        needsAttention: board.summary.needsAttention
      }
    ],
    agent_cards: board.cards.map(cardRow),
    next_actions: board.actions.map(actionRow)
  } satisfies Record<string, JsonValue>
});

export const buildAgentBoardArtifact = (board: AgentBoard): AgentBoardArtifact => ({
  surface: "dashboard",
  manifest: manifest(board),
  snapshot: snapshot(board),
  sources: []
});
