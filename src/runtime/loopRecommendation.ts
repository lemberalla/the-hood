import fs from "node:fs/promises";
import path from "node:path";
import { resolveRepoPath } from "./paths.js";
import type { JsonObject, JsonValue, RunMode } from "./types.js";

export const loopRecipeIds = [
  "build-test-fix",
  "verifier-loop",
  "anti-spin",
  "completion-contract",
  "quality-streak",
  "adversarial-review",
  "human-approval-queue"
] as const;

export type LoopRecipeId = (typeof loopRecipeIds)[number];
export type LoopRecipeStatus = "available" | "partial" | "planned";
export type LoopRecommendationConfidence = "high" | "medium" | "low";

export interface LoopRecipe {
  id: LoopRecipeId;
  title: string;
  plainLabel: string;
  status: LoopRecipeStatus;
  purpose: string;
  whenToUse: string;
  roles: string[];
  requiredEvidence: string[];
  stopConditions: string[];
  risks: string[];
  commandShape: string;
}

export interface CompletionContractDraft {
  goal: string;
  acceptanceCriteria: string[];
  validationCommands: string[];
  allowedPaths: string[];
  forbiddenChanges: string[];
  requiredEvidence: string[];
  reviewerRoles: string[];
  iterationBudget: number;
  stopConditions: string[];
}

export interface LoopRecipeScore {
  recipe: LoopRecipe;
  score: number;
  signals: string[];
}

export interface LoopRecommendationAction {
  tool: string;
  arguments: JsonObject;
  description: string;
}

export type LoopCardActionId = "run_loop" | "edit_contract" | "show_alternatives";
export type LoopCardActionStyle = "primary" | "secondary";

export interface LoopCardAction {
  action: LoopCardActionId;
  label: string;
  style: LoopCardActionStyle;
  description: string;
  tool?: string;
  arguments?: JsonObject;
  commandHint?: string;
}

export interface LoopRecommendationCardSection {
  id: string;
  title: string;
  items: string[];
}

export interface LoopRecommendationCardBadge {
  label: string;
  value: string;
}

export interface LoopRecommendationCard {
  title: string;
  subtitle: string;
  badges: LoopRecommendationCardBadge[];
  sections: LoopRecommendationCardSection[];
  actions: LoopCardAction[];
  rendererHint: string;
}

export interface LoopStackItem {
  order: number;
  recipe: LoopRecipe;
  required: boolean;
  purpose: string;
}

export interface LoopRecommendation {
  kind: "loop_recommendation";
  schemaVersion: 1;
  repoPath: string;
  goal: string;
  recommended: LoopRecipeScore;
  alternatives: LoopRecipeScore[];
  stack: LoopStackItem[];
  confidence: LoopRecommendationConfidence;
  reason: string;
  contract: CompletionContractDraft;
  runAction: LoopRecommendationAction;
  actions: LoopCardAction[];
  card: LoopRecommendationCard;
  notes: string[];
  artifact: LoopRecommendationArtifact;
}

export interface LoopRecommendationArtifact {
  surface: "dashboard";
  manifest: JsonObject;
  snapshot: JsonObject;
  sources: [];
}

interface RecommendLoopInput {
  repoPath: string;
  goal: string;
  constraints?: string[];
  maxIterations?: number;
  acceptanceCriteria?: string[];
  validationCommands?: string[];
  allowedPaths?: string[];
  forbiddenChanges?: string[];
}

interface ScoringRule {
  pattern: RegExp;
  score: number;
  signal: string;
}

const recipeCatalog: LoopRecipe[] = [
  {
    id: "build-test-fix",
    title: "Build, Test, Fix",
    plainLabel: "Fix something and prove it",
    status: "available",
    purpose: "Implement a scoped software change, capture validation evidence, and repair fixable failures until clean or capped.",
    whenToUse: "Use when the goal asks TheHood to fix, implement, repair, or build something with clear validation.",
    roles: ["orchestrator", "implementer", "runtime QA", "qa", "verifier"],
    requiredEvidence: ["scoped diff", "runtime-captured validation command logs", "review routing", "verifier verdict"],
    stopConditions: ["verifier approves", "manual approval is required", "max iterations reached", "unsafe or unresolved blocker"],
    risks: ["too-broad scope", "missing validation command", "protected test changes without approval"],
    commandShape: "thehood goal \"<task>\" --repo . --max-iterations <n>"
  },
  {
    id: "verifier-loop",
    title: "Verifier Loop",
    plainLabel: "Prove correctness independently",
    status: "available",
    purpose: "Run implementation evidence through independent verification when correctness matters more than speed.",
    whenToUse: "Use when the user asks to prove, verify, audit, or make a sensitive change where self-review is not enough.",
    roles: ["orchestrator", "implementer", "runtime QA", "verifier"],
    requiredEvidence: ["acceptance criteria", "runtime-captured command evidence", "diff evidence", "verifier verdict"],
    stopConditions: ["verifier approves", "verifier asks the user", "verifier aborts", "max iterations reached"],
    risks: ["accepting model summaries instead of raw evidence", "same authority implementing and verifying"],
    commandShape: "thehood goal \"<task>\" --repo . --max-iterations <n>"
  },
  {
    id: "anti-spin",
    title: "Anti-Spin",
    plainLabel: "Stop repeated agent thrash",
    status: "partial",
    purpose: "Constrain ambiguous or failure-prone work so repeated attempts stop instead of looping without progress.",
    whenToUse: "Use when a task has repeated failures, duplicate evidence requests, unclear proof, or a risk of flip-flopping approaches.",
    roles: ["orchestrator", "runtime", "verifier", "operator"],
    requiredEvidence: ["last failed evidence", "repeated-failure signal", "budget state", "stop reason"],
    stopConditions: ["same failure repeats", "duplicate evidence request", "no diff after repair", "max iterations reached", "provider blocked or failed"],
    risks: ["stopping too late", "reporting exhaustion as success", "asking for the same context repeatedly"],
    commandShape: "thehood goal \"<task>\" --repo . --max-iterations <low n>"
  },
  {
    id: "completion-contract",
    title: "Completion Contract",
    plainLabel: "Define done before work starts",
    status: "partial",
    purpose: "Make the definition of done explicit before a loop begins, especially for release-facing or high-trust work.",
    whenToUse: "Use when public preview, release, packaging, security, privacy, docs, or product trust depends on not calling partial work done.",
    roles: ["orchestrator", "implementer", "runtime QA", "qa", "verifier", "critic"],
    requiredEvidence: ["acceptance criteria", "allowed and forbidden changes", "validation commands", "final report evidence refs"],
    stopConditions: ["all required evidence is proved", "required evidence is weak or missing", "approval boundary", "max iterations reached"],
    risks: ["too-vague acceptance criteria", "missing forbidden changes", "partial completion reported as done"],
    commandShape: "thehood goal \"<task>\" --repo . --max-iterations <n>"
  },
  {
    id: "quality-streak",
    title: "Quality Streak",
    plainLabel: "Require repeated clean passes",
    status: "planned",
    purpose: "Require several consecutive successful validations before declaring unstable behavior fixed.",
    whenToUse: "Use when flaky, intermittent, or stability-sensitive work should not stop after one green run.",
    roles: ["runtime QA", "qa", "verifier"],
    requiredEvidence: ["same validation command repeated under recorded conditions", "streak count", "failure reset evidence"],
    stopConditions: ["target streak reached", "failure resets streak", "budget exhausted", "approval required"],
    risks: ["expensive repeated validation", "overfitting to one scenario", "claiming streak support before it is implemented"],
    commandShape: "planned: thehood goal \"<task>\" --repo . --recipe quality-streak --streak <n>"
  },
  {
    id: "adversarial-review",
    title: "Adversarial Review",
    plainLabel: "Challenge the plan or patch",
    status: "partial",
    purpose: "Bring in a read-only critic or second model family to challenge risky plans, architecture, UX, security, or release decisions.",
    whenToUse: "Use when disagreement, risk, architecture, security, product strategy, or public trust warrants critique before acceptance.",
    roles: ["orchestrator", "qa", "critic", "verifier"],
    requiredEvidence: ["critic response", "runtime validation evidence", "verifier verdict"],
    stopConditions: ["critic finds no blocking concern and verifier approves", "fixable critique becomes revision packet", "unsafe critic finding", "approval required"],
    risks: ["treating sidecar critique as acceptance", "reviewing an old version after edits", "model-family consensus claims without separate providers"],
    commandShape: "thehood summon <run-id> --role critic --brief \"Challenge this plan\""
  },
  {
    id: "human-approval-queue",
    title: "Human Approval Queue",
    plainLabel: "Pause for decisions",
    status: "available",
    purpose: "Make approval gates explicit when work crosses edit, protected-path, dependency, network, or external-transfer boundaries.",
    whenToUse: "Use when the likely next step needs the user to approve, revise, reject, or abort before the runtime can continue.",
    roles: ["operator", "runtime", "orchestrator", "implementer", "verifier"],
    requiredEvidence: ["approval reason", "artifact refs", "operator decision", "resume event"],
    stopConditions: ["user approves", "user revises", "user rejects", "user aborts", "approval remains pending"],
    risks: ["approval fatigue", "unclear reason copy", "manual copy-paste loops"],
    commandShape: "thehood approvals policy show --repo ."
  }
];

const scoringRules: Record<LoopRecipeId, ScoringRule[]> = {
  "build-test-fix": [
    { pattern: /\b(fix|repair|implement|build|change|add|wire|patch|failing|test|bug|broken)\b/i, score: 5, signal: "scoped implementation or repair language" },
    { pattern: /\b(typecheck|test|lint|build|smoke|ci)\b/i, score: 3, signal: "validation command language" }
  ],
  "verifier-loop": [
    { pattern: /\b(verify|prove|correct|correctness|audit|evidence|confidence|safe|regression)\b/i, score: 5, signal: "independent proof is important" },
    { pattern: /\b(security|privacy|payment|auth|release|public)\b/i, score: 3, signal: "higher correctness risk" }
  ],
  "anti-spin": [
    { pattern: /\b(stuck|looping|spin|thrash|again|keeps|repeat|repeated|deadlock|blocked|same failure|no progress|oscillat|flip.?flop)\b/i, score: 6, signal: "risk of repeated unproductive attempts" },
    { pattern: /\b(ambiguous|unclear|vague|not obvious)\b/i, score: 2, signal: "ambiguous next step" }
  ],
  "completion-contract": [
    { pattern: /\b(done|complete|completion|ship|release|preview|publish|npm|package|public|launch|ready|readiness)\b/i, score: 6, signal: "definition of done matters" },
    { pattern: /\b(privacy|security|trust|docs|documentation|claim|positioning|pricing|migration)\b/i, score: 3, signal: "public or trust-sensitive work" }
  ],
  "quality-streak": [
    { pattern: /\b(flaky|flake|intermittent|stabilize|stability|reliable|reliability|streak|consecutive|race|timing)\b/i, score: 6, signal: "needs repeated clean validation" },
    { pattern: /\b(test|suite|smoke|ci)\b/i, score: 2, signal: "validation can be repeated" }
  ],
  "adversarial-review": [
    { pattern: /\b(review|critic|critique|challenge|second judge|red.?team|adversarial|disagree|consensus)\b/i, score: 6, signal: "asks for challenge or second judgment" },
    { pattern: /\b(architecture|strategy|security|privacy|ux|product|release|public|risky|risk)\b/i, score: 4, signal: "higher-risk judgment benefits from critique" }
  ],
  "human-approval-queue": [
    { pattern: /\b(approve|approval|permission|gate|manual|ask me|confirm|protected|dependency|network|external transfer|secret)\b/i, score: 6, signal: "approval boundary likely" },
    { pattern: /\b(pause|resume|revise|reject|abort)\b/i, score: 3, signal: "operator decision language" }
  ]
};

export const listLoopRecipes = (): LoopRecipe[] => recipeCatalog.map((recipe) => ({ ...recipe }));

const recipeById = (id: LoopRecipeId): LoopRecipe => {
  const recipe = recipeCatalog.find((candidate) => candidate.id === id);
  if (!recipe) {
    throw new Error(`Unknown loop recipe ${id}.`);
  }
  return recipe;
};

const scoreRecipe = (recipe: LoopRecipe, text: string): LoopRecipeScore => {
  const rules = scoringRules[recipe.id];
  const matched = rules.filter((rule) => rule.pattern.test(text));
  const ruleScore = matched.reduce((total, rule) => total + rule.score, 0);
  const defaultScore = recipe.id === "build-test-fix" ? 2 : 0;
  const statusAdjustment = recipe.status === "planned" ? -2 : 0;
  return {
    recipe,
    score: Math.max(0, ruleScore + defaultScore + statusAdjustment),
    signals: matched.map((rule) => rule.signal)
  };
};

const confidenceFor = (scores: LoopRecipeScore[]): LoopRecommendationConfidence => {
  const [top, second] = scores;
  if (!top || top.score < 4) {
    return "low";
  }

  if (!second || top.score - second.score >= 4 || top.score >= 8) {
    return "high";
  }

  return "medium";
};

const recommendationReason = (score: LoopRecipeScore, confidence: LoopRecommendationConfidence): string => {
  const signals = score.signals.length > 0
    ? score.signals.join("; ")
    : "it is the safest default for scoped software goal loops";
  return `${score.recipe.title} is the ${confidence}-confidence recommendation because ${signals}.`;
};

const stackIdsFor = (recipeId: LoopRecipeId): LoopRecipeId[] => {
  switch (recipeId) {
    case "completion-contract":
      return ["completion-contract", "adversarial-review", "verifier-loop"];
    case "adversarial-review":
      return ["adversarial-review", "verifier-loop"];
    case "quality-streak":
      return ["quality-streak", "verifier-loop"];
    case "anti-spin":
      return ["anti-spin", "human-approval-queue"];
    default:
      return [recipeId];
  }
};

const recommendationStack = (recipe: LoopRecipe): LoopStackItem[] =>
  stackIdsFor(recipe.id).map((recipeId, index) => {
    const stackRecipe = recipeById(recipeId);
    return {
      order: index + 1,
      recipe: stackRecipe,
      required: index === 0,
      purpose: index === 0
        ? "Primary loop shape selected for this goal."
        : `Companion check: ${stackRecipe.purpose}`
    };
  });

const packageScripts = async (repoPath: string): Promise<string[]> => {
  const packagePath = path.join(repoPath, "package.json");
  try {
    const parsed = JSON.parse(await fs.readFile(packagePath, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }

    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
      return [];
    }

    return ["typecheck", "test", "lint", "build", "smoke:runtime", "smoke:mcp"]
      .filter((name) => typeof (scripts as Record<string, unknown>)[name] === "string")
      .map((name) => `npm run ${name}`);
  } catch {
    return [];
  }
};

const defaultValidationCommands = async (repoPath: string, recipeId: LoopRecipeId): Promise<string[]> => {
  const discovered = await packageScripts(repoPath);
  if (discovered.length > 0) {
    return discovered.slice(0, 4);
  }

  if (recipeId === "completion-contract" || recipeId === "verifier-loop") {
    return ["project-defined validation command"];
  }

  return ["existing test or build command"];
};

const acceptanceCriteriaFor = (recipe: LoopRecipe): string[] => {
  switch (recipe.id) {
    case "completion-contract":
      return [
        "Every required outcome is mapped to current evidence.",
        "Allowed paths, forbidden changes, validation commands, and stop conditions are explicit before implementation.",
        "The final report references runtime-captured evidence instead of model summaries."
      ];
    case "quality-streak":
      return [
        "The relevant validation passes repeatedly under recorded conditions.",
        "Any failure resets the streak instead of counting as success.",
        "The run is marked planned/docs-only until quality-streak execution is implemented."
      ];
    case "adversarial-review":
      return [
        "A read-only critic challenges the current plan or patch.",
        "Fixable concerns become revision work; sidecar critique does not satisfy acceptance.",
        "Runtime validation and verifier review still decide completion."
      ];
    case "anti-spin":
      return [
        "The run has a low iteration budget and concrete evidence requests.",
        "Repeated failures, duplicate context requests, no-diff repairs, or flip-flops stop the loop.",
        "Exhaustion or blockers are reported honestly, not as success."
      ];
    case "human-approval-queue":
      return [
        "Approval gates show the exact reason, affected refs, and available decisions.",
        "The runtime resumes only after approve, revise, reject, or abort.",
        "Manual approval is recorded as evidence."
      ];
    case "verifier-loop":
      return [
        "Runtime captures validation evidence before review.",
        "Verifier is independent from the implementer.",
        "Verifier approves, requests revision, asks the user, or aborts with evidence."
      ];
    case "build-test-fix":
      return [
        "The scoped change is implemented without unrelated edits.",
        "Runtime captures validation command evidence.",
        "Fixable failures become revision packets and the verifier reviews fresh evidence."
      ];
  }
};

const contractFor = async (
  repoPath: string,
  goal: string,
  recipe: LoopRecipe,
  maxIterations: number,
  input: RecommendLoopInput
): Promise<CompletionContractDraft> => ({
  goal,
  acceptanceCriteria: input.acceptanceCriteria?.length
    ? input.acceptanceCriteria
    : acceptanceCriteriaFor(recipe),
  validationCommands: input.validationCommands?.length
    ? input.validationCommands
    : await defaultValidationCommands(repoPath, recipe.id),
  allowedPaths: input.allowedPaths?.length
    ? input.allowedPaths
    : ["Paths implied by the goal and approved runtime plan."],
  forbiddenChanges: [
    ...(input.forbiddenChanges?.length ? input.forbiddenChanges : ["Unrelated files."]),
    "Secrets, credentials, browser profiles, or private run logs.",
    "Protected test, fixture, snapshot, or eval changes without explicit approval."
  ],
  requiredEvidence: recipe.requiredEvidence,
  reviewerRoles: recipe.roles.filter((role) => role === "qa" || role === "verifier" || role === "critic"),
  iterationBudget: maxIterations,
  stopConditions: recipe.stopConditions
});

const constraintLines = (recipe: LoopRecipe, contract: CompletionContractDraft): string[] => [
  `Loop recipe: ${recipe.id}`,
  `Loop purpose: ${recipe.purpose}`,
  `Required evidence: ${contract.requiredEvidence.join("; ")}`,
  `Acceptance criteria: ${contract.acceptanceCriteria.join("; ")}`,
  `Validation commands: ${contract.validationCommands.join("; ")}`,
  `Allowed paths: ${contract.allowedPaths.join("; ")}`,
  `Stop conditions: ${contract.stopConditions.join("; ")}`,
  `Forbidden changes: ${contract.forbiddenChanges.join("; ")}`
];

const runActionFor = (
  repoPath: string,
  goal: string,
  recipe: LoopRecipe,
  stack: LoopStackItem[],
  contract: CompletionContractDraft
): LoopRecommendationAction => ({
  tool: "thehood_orchestrate",
  description: "Start the recommended loop through the existing runtime. The runtime still owns approvals, evidence, verification, and stop conditions.",
  arguments: {
    goal,
    repo_path: repoPath,
    mode: "implement" satisfies RunMode,
    auto_loop: true,
    constraints: [
      `Loop stack: ${stack.map((item) => item.recipe.id).join(" -> ")}`,
      ...constraintLines(recipe, contract)
    ]
  }
});

const cardActionsFor = (runAction: LoopRecommendationAction): LoopCardAction[] => [
  {
    action: "run_loop",
    label: "Run loop",
    style: "primary",
    description: runAction.description,
    tool: runAction.tool,
    arguments: runAction.arguments
  },
  {
    action: "edit_contract",
    label: "Edit contract",
    style: "secondary",
    description: "Adjust acceptance criteria, validation commands, allowed paths, forbidden changes, or iteration budget before starting.",
    commandHint: "Re-run recommend-loop with --acceptance, --validation, --allowed-path, --forbidden-change, or --max-iterations."
  },
  {
    action: "show_alternatives",
    label: "Show alternatives",
    style: "secondary",
    description: "Compare other loop choices without starting providers, edits, schedules, or external transfers."
  }
];

const loopChoiceRows = (recommendation: Omit<LoopRecommendation, "artifact">): JsonObject[] =>
  [
    recommendation.recommended,
    ...recommendation.alternatives
  ].map((score, index) => ({
    rank: index + 1,
    recipe: score.recipe.id,
    title: score.recipe.title,
    label: score.recipe.plainLabel,
    status: score.recipe.status,
    score: score.score,
    signals: score.signals.join(", "),
    purpose: score.recipe.purpose,
    stopConditions: score.recipe.stopConditions.join("; ")
  }));

const stackRows = (stack: LoopStackItem[]): JsonObject[] =>
  stack.map((item) => ({
    order: item.order,
    recipe: item.recipe.id,
    title: item.recipe.title,
    status: item.recipe.status,
    required: item.required,
    purpose: item.purpose
  }));

const contractRows = (contract: CompletionContractDraft): JsonObject[] => [
  { field: "Goal", value: contract.goal },
  { field: "Acceptance Criteria", value: contract.acceptanceCriteria.join("; ") },
  { field: "Validation", value: contract.validationCommands.join("; ") },
  { field: "Allowed Paths", value: contract.allowedPaths.join("; ") },
  { field: "Forbidden Changes", value: contract.forbiddenChanges.join("; ") },
  { field: "Required Evidence", value: contract.requiredEvidence.join("; ") },
  { field: "Reviewer Roles", value: contract.reviewerRoles.join(", ") || "runtime/verifier as configured" },
  { field: "Iteration Budget", value: String(contract.iterationBudget) },
  { field: "Stop Conditions", value: contract.stopConditions.join("; ") }
];

const actionRows = (actions: LoopCardAction[]): JsonObject[] =>
  actions.map((action, index) => ({
    order: index + 1,
    action: action.action,
    label: action.label,
    style: action.style,
    tool: action.tool ?? "",
    commandHint: action.commandHint ?? "",
    description: action.description
  }));

const cardFor = (
  score: LoopRecipeScore,
  confidence: LoopRecommendationConfidence,
  reason: string,
  stack: LoopStackItem[],
  contract: CompletionContractDraft,
  actions: LoopCardAction[]
): LoopRecommendationCard => ({
  title: `Recommended loop: ${score.recipe.title}`,
  subtitle: reason,
  badges: [
    { label: "Confidence", value: confidence },
    { label: "Recipe", value: score.recipe.id },
    { label: "Status", value: score.recipe.status }
  ],
  sections: [
    {
      id: "stack",
      title: "Stack",
      items: stack.map((item) =>
        `${item.order}. ${item.recipe.title}${item.required ? " (primary)" : " (companion)"}`
      )
    },
    {
      id: "contract",
      title: "Completion Contract",
      items: [
        `Goal: ${contract.goal}`,
        `Evidence: ${contract.requiredEvidence.join("; ")}`,
        `Validation: ${contract.validationCommands.join("; ")}`,
        `Stops: ${contract.stopConditions.join("; ")}`,
        `Budget: ${contract.iterationBudget}`
      ]
    },
    {
      id: "boundaries",
      title: "Boundaries",
      items: contract.forbiddenChanges
    }
  ],
  actions,
  rendererHint: "Render this card first. Use artifact.manifest and artifact.snapshot as the table/dashboard fallback."
});

const buildRecommendationArtifact = (
  recommendation: Omit<LoopRecommendation, "artifact">
): LoopRecommendationArtifact => ({
  surface: "dashboard",
  manifest: {
    version: 1,
    surface: "dashboard",
    title: "TheHood Loop Plan",
    description: "A read-only recommendation for choosing a governed software goal-loop recipe.",
    blocks: [
      {
        id: "intro",
        type: "markdown",
        body: [
          "# TheHood Loop Plan",
          recommendation.reason,
          "",
          "This is a recommendation only. Running the loop still goes through TheHood runtime approvals, evidence capture, verification, and stop conditions."
        ].join("\n")
      },
      {
        id: "recipes",
        type: "table",
        tableId: "loop_recipes"
      },
      {
        id: "stack",
        type: "table",
        tableId: "loop_stack"
      },
      {
        id: "contract",
        type: "table",
        tableId: "completion_contract"
      },
      {
        id: "actions",
        type: "table",
        tableId: "card_actions"
      }
    ],
    tables: [
      {
        id: "loop_recipes",
        title: "Loop Choices",
        dataset: "loop_recipes",
        columns: [
          { field: "rank", header: "Rank" },
          { field: "title", header: "Loop" },
          { field: "label", header: "Plain Label" },
          { field: "status", header: "Status" },
          { field: "signals", header: "Why" },
          { field: "stopConditions", header: "Stops On" }
        ],
        defaultSort: { field: "rank", direction: "asc" }
      },
      {
        id: "loop_stack",
        title: "Recommended Stack",
        dataset: "loop_stack",
        columns: [
          { field: "order", header: "Order" },
          { field: "title", header: "Loop" },
          { field: "status", header: "Status" },
          { field: "required", header: "Primary" },
          { field: "purpose", header: "Purpose" }
        ],
        defaultSort: { field: "order", direction: "asc" }
      },
      {
        id: "completion_contract",
        title: "Completion Contract Draft",
        dataset: "completion_contract",
        columns: [
          { field: "field", header: "Field" },
          { field: "value", header: "Draft" }
        ],
        defaultSort: { field: "field", direction: "asc" }
      },
      {
        id: "card_actions",
        title: "Actions",
        dataset: "card_actions",
        columns: [
          { field: "order", header: "Order" },
          { field: "label", header: "Action" },
          { field: "style", header: "Style" },
          { field: "tool", header: "Tool" },
          { field: "description", header: "Description" }
        ],
        defaultSort: { field: "order", direction: "asc" }
      }
    ]
  },
  snapshot: {
    version: 1,
    status: "ready",
    datasets: {
      loop_recipes: loopChoiceRows(recommendation),
      loop_stack: stackRows(recommendation.stack),
      completion_contract: contractRows(recommendation.contract),
      card_actions: actionRows(recommendation.actions)
    } satisfies Record<string, JsonValue>
  },
  sources: []
});

export const recommendLoop = async (input: RecommendLoopInput): Promise<LoopRecommendation> => {
  const repoPath = resolveRepoPath(input.repoPath);
  const goal = input.goal.trim();
  if (!goal) {
    throw new Error("Loop recommendation goal cannot be empty.");
  }

  const text = [goal, ...(input.constraints ?? [])].join("\n");
  const scores = listLoopRecipes()
    .map((recipe) => scoreRecipe(recipe, text))
    .sort((left, right) => right.score - left.score || left.recipe.id.localeCompare(right.recipe.id));
  const recommended = scores[0] ?? scoreRecipe(recipeById("build-test-fix"), text);
  const alternatives = scores
    .filter((score) => score.recipe.id !== recommended.recipe.id)
    .slice(0, 3);
  const confidence = confidenceFor([recommended, ...alternatives]);
  const maxIterations = input.maxIterations ?? 5;
  const stack = recommendationStack(recommended.recipe);
  const contract = await contractFor(repoPath, goal, recommended.recipe, maxIterations, input);
  const runAction = runActionFor(repoPath, goal, recommended.recipe, stack, contract);
  const actions = cardActionsFor(runAction);
  const reason = recommendationReason(recommended, confidence);
  const withoutArtifact: Omit<LoopRecommendation, "artifact"> = {
    kind: "loop_recommendation",
    schemaVersion: 1,
    repoPath,
    goal,
    recommended,
    alternatives,
    stack,
    confidence,
    reason,
    contract,
    runAction,
    actions,
    card: cardFor(recommended, confidence, reason, stack, contract, actions),
    notes: [
      "The user does not need to know recipe IDs before asking for a loop.",
      "Recipe selection is read-only and does not start providers, edits, schedules, or external transfers.",
      "Quality streak is a documented/planned recipe; current execution should use existing runtime validation and verifier gates."
    ]
  };

  return {
    ...withoutArtifact,
    artifact: buildRecommendationArtifact(withoutArtifact)
  };
};
