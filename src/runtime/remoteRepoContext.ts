import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { writeRunArtifact } from "./artifacts.js";
import { parseGitStatusPaths } from "./gitEvidence.js";
import { newId, nowIso } from "./ids.js";
import { resolveRepoPath } from "./paths.js";
import { loadRun, saveRun } from "./store.js";
import type { JsonObject, JsonValue, RoleAssignment, RunArtifact, RunRecord } from "./types.js";

export interface GitHubRemoteRef {
  name: string;
  owner: string;
  repo: string;
  url: string;
  normalizedUrl: string;
}

export interface RemoteRepoContextInspection {
  provider: string;
  repoPath: string;
  githubRemote?: GitHubRemoteRef;
  branch?: string;
  commit?: string;
  upstream?: string;
  upstreamCommit?: string;
  clean: boolean;
  pushed: boolean;
  statusPathCount: number;
  statusPaths: string[];
  reasons: string[];
}

export type RepoContextRoute = "github_connector" | "local_bundle";

export interface RepoContextRouteDecision {
  route: RepoContextRoute;
  reason: string;
  reasons: string[];
}

export interface GitHubConnectorRepoContext {
  schemaVersion: 1;
  kind: "github_connector_repo_context";
  generatedAt: string;
  repoPath: string;
  runId: string;
  goal: string;
  delegate: JsonObject;
  route: "github_connector";
  remote: {
    provider: "github";
    remoteName: string;
    owner: string;
    repo: string;
    url: string;
    normalizedUrl: string;
    branch?: string;
    commit: string;
    upstream?: string;
    upstreamCommit?: string;
  };
  localState: {
    clean: boolean;
    pushed: boolean;
    statusPathCount: number;
    statusPaths: string[];
    reasons: string[];
  };
  instructions: string[];
  notes: string[];
}

export interface CaptureRemoteRepoContextResult {
  selected: boolean;
  run: RunRecord;
  routeDecision: RepoContextRouteDecision;
  inspection: RemoteRepoContextInspection;
  artifact?: RunArtifact;
  context?: GitHubConnectorRepoContext;
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const maxStatusPaths = 20;

const runGit = async (repoPath: string, args: string[]): Promise<GitResult> =>
  new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: repoPath,
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
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr
      });
    });
  });

const stringFromGit = (result: GitResult): string | undefined => {
  const value = result.stdout.trim();
  return result.exitCode === 0 && value.length > 0 ? value : undefined;
};

export const parseGitHubRemoteUrl = (
  url: string
): Omit<GitHubRemoteRef, "name" | "url"> | undefined => {
  const trimmed = url.trim();
  const scpMatch = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);

  if (scpMatch?.[1] && scpMatch[2]) {
    return {
      owner: scpMatch[1],
      repo: scpMatch[2],
      normalizedUrl: `https://github.com/${scpMatch[1]}/${scpMatch[2]}`
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  if (parsed.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }

  const parts = parsed.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return undefined;
  }

  const repo = parts[1].replace(/\.git$/, "");
  if (!repo) {
    return undefined;
  }

  return {
    owner: parts[0],
    repo,
    normalizedUrl: `https://github.com/${parts[0]}/${repo}`
  };
};

const githubRemotesFromGitOutput = (stdout: string): GitHubRemoteRef[] => {
  const remotes: GitHubRemoteRef[] = [];

  for (const line of stdout.split("\n")) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch)\)$/);
    if (!match?.[1] || !match[2]) {
      continue;
    }

    const parsed = parseGitHubRemoteUrl(match[2]);
    if (!parsed) {
      continue;
    }

    remotes.push({
      name: match[1],
      url: match[2],
      ...parsed
    });
  }

  return remotes.sort((left, right) =>
    (left.name === "origin" ? 0 : 1) - (right.name === "origin" ? 0 : 1) ||
    left.name.localeCompare(right.name)
  );
};

const normalizeDelegate = (delegate: JsonValue | undefined): JsonObject =>
  delegate && typeof delegate === "object" && !Array.isArray(delegate) ? delegate : {};

export const chooseRepoContextRoute = (
  inspection: RemoteRepoContextInspection
): RepoContextRouteDecision => {
  const reasons = [...inspection.reasons];

  if (inspection.provider !== "chatgpt-web") {
    return {
      route: "local_bundle",
      reason: "provider_does_not_support_github_connector_context",
      reasons: [...reasons, "provider_does_not_support_github_connector_context"]
    };
  }

  if (!inspection.githubRemote) {
    return {
      route: "local_bundle",
      reason: "no_github_remote",
      reasons: [...reasons, "no_github_remote"]
    };
  }

  if (!inspection.commit) {
    return {
      route: "local_bundle",
      reason: "missing_head_commit",
      reasons: [...reasons, "missing_head_commit"]
    };
  }

  if (!inspection.clean) {
    return {
      route: "local_bundle",
      reason: "dirty_checkout",
      reasons: [...reasons, "dirty_checkout"]
    };
  }

  if (!inspection.pushed) {
    return {
      route: "local_bundle",
      reason: "head_not_pushed_to_upstream",
      reasons: [...reasons, "head_not_pushed_to_upstream"]
    };
  }

  return {
    route: "github_connector",
    reason: "clean_pushed_github_repo",
    reasons
  };
};

export const inspectRemoteRepoContext = async (
  repoPathInput: string,
  assignment: RoleAssignment
): Promise<RemoteRepoContextInspection> => {
  const repoPath = resolveRepoPath(repoPathInput);
  const reasons: string[] = [];
  const remoteOutput = await runGit(repoPath, ["remote", "-v"]);
  const remotes = remoteOutput.exitCode === 0 ? githubRemotesFromGitOutput(remoteOutput.stdout) : [];
  const githubRemote = remotes[0];

  if (!githubRemote) {
    reasons.push("no_github_remote");
  }

  const status = await runGit(repoPath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).thehood"
  ]);
  const statusPaths = status.exitCode === 0 ? parseGitStatusPaths(status.stdout) : [];
  const clean = status.exitCode === 0 && statusPaths.length === 0;

  if (status.exitCode !== 0) {
    reasons.push("git_status_unavailable");
  } else if (!clean) {
    reasons.push("dirty_checkout");
  }

  const commit = stringFromGit(await runGit(repoPath, ["rev-parse", "HEAD"]));
  if (!commit) {
    reasons.push("missing_head_commit");
  }

  const branch = stringFromGit(await runGit(repoPath, ["branch", "--show-current"]));
  const upstream = stringFromGit(await runGit(repoPath, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}"
  ]));
  const upstreamCommit = stringFromGit(await runGit(repoPath, ["rev-parse", "@{u}"]));
  const pushed = Boolean(commit && upstreamCommit && commit === upstreamCommit);

  if (!upstream || !upstreamCommit) {
    reasons.push("missing_upstream_ref");
  } else if (!pushed) {
    reasons.push("head_differs_from_upstream");
  }

  return {
    provider: assignment.provider,
    repoPath,
    ...(githubRemote ? { githubRemote } : {}),
    ...(branch ? { branch } : {}),
    ...(commit ? { commit } : {}),
    ...(upstream ? { upstream } : {}),
    ...(upstreamCommit ? { upstreamCommit } : {}),
    clean,
    pushed,
    statusPathCount: statusPaths.length,
    statusPaths: statusPaths.slice(0, maxStatusPaths),
    reasons: Array.from(new Set(reasons))
  };
};

const buildGitHubConnectorRepoContext = (
  run: RunRecord,
  delegate: JsonValue | undefined,
  inspection: RemoteRepoContextInspection,
  routeDecision: RepoContextRouteDecision
): GitHubConnectorRepoContext => {
  if (!inspection.githubRemote || !inspection.commit) {
    throw new Error("Cannot build GitHub connector context without GitHub remote and HEAD commit.");
  }

  return {
    schemaVersion: 1,
    kind: "github_connector_repo_context",
    generatedAt: nowIso(),
    repoPath: inspection.repoPath,
    runId: run.runId,
    goal: run.userGoal,
    delegate: normalizeDelegate(delegate),
    route: "github_connector",
    remote: {
      provider: "github",
      remoteName: inspection.githubRemote.name,
      owner: inspection.githubRemote.owner,
      repo: inspection.githubRemote.repo,
      url: inspection.githubRemote.url,
      normalizedUrl: inspection.githubRemote.normalizedUrl,
      ...(inspection.branch ? { branch: inspection.branch } : {}),
      commit: inspection.commit,
      ...(inspection.upstream ? { upstream: inspection.upstream } : {}),
      ...(inspection.upstreamCommit ? { upstreamCommit: inspection.upstreamCommit } : {})
    },
    localState: {
      clean: inspection.clean,
      pushed: inspection.pushed,
      statusPathCount: inspection.statusPathCount,
      statusPaths: inspection.statusPaths,
      reasons: routeDecision.reasons
    },
    instructions: [
      "Use ChatGPT Web's GitHub connector to inspect this repository at the exact commit and branch named here.",
      "Do not assume provider chat history or project context is current; use TheHood runtime state and this remote ref as the source of truth.",
      "Treat TheHood artifacts and local runtime state as authoritative if they conflict with connector-visible repository content.",
      "Ask TheHood for a bounded local repo context pack if GitHub connector access is unavailable or the requested evidence is not visible at this commit."
    ],
    notes: [
      "This refs-only context was selected because local git reported a clean checkout with HEAD matching the tracked upstream ref.",
      "No local file excerpts are included in this artifact.",
      "The runtime falls back to bounded local context packs for local-only, dirty, unpushed, or non-ChatGPT providers."
    ]
  };
};

export const captureRemoteRepoContext = async (
  run: RunRecord,
  assignment: RoleAssignment,
  delegate: JsonValue | undefined
): Promise<CaptureRemoteRepoContextResult> => {
  const inspection = await inspectRemoteRepoContext(run.repoPath, assignment);
  const routeDecision = chooseRepoContextRoute(inspection);

  if (routeDecision.route !== "github_connector") {
    return {
      selected: false,
      run,
      routeDecision,
      inspection
    };
  }

  const context = buildGitHubConnectorRepoContext(run, delegate, inspection, routeDecision);
  const artifact = await writeRunArtifact({
    repoPath: context.repoPath,
    runId: run.runId,
    kind: "remote_context",
    name: `github-connector-context-${newId("remote-context")}.json`,
    content: `${JSON.stringify(context, null, 2)}\n`,
    summary: `GitHub connector context for ${context.remote.owner}/${context.remote.repo}@${context.remote.commit.slice(0, 12)}.`
  });
  const latestRun = await loadRun(context.repoPath, run.runId);
  const updated: RunRecord = {
    ...latestRun,
    updatedAt: nowIso(),
    artifacts: [...latestRun.artifacts, artifact],
    events: [
      ...latestRun.events,
      {
        id: newId("event"),
        createdAt: nowIso(),
        type: "remote_repo_context_selected",
        message: `Selected GitHub connector context for ${context.remote.owner}/${context.remote.repo}.`,
        data: {
          transport: "github_connector",
          provider: assignment.provider,
          model: assignment.model,
          owner: context.remote.owner,
          repo: context.remote.repo,
          normalizedUrl: context.remote.normalizedUrl,
          ...(context.remote.branch ? { branch: context.remote.branch } : {}),
          commit: context.remote.commit,
          ...(context.remote.upstream ? { upstream: context.remote.upstream } : {}),
          reason: routeDecision.reason,
          artifactRef: artifact.ref
        }
      }
    ]
  };

  await saveRun(updated);

  return {
    selected: true,
    run: updated,
    routeDecision,
    inspection,
    artifact,
    context
  };
};

export const remoteRepoContextArtifacts = (run: RunRecord): RunArtifact[] =>
  run.artifacts.filter((artifact) => artifact.kind === "remote_context");

export const latestRemoteRepoContextArtifact = (run: RunRecord): RunArtifact | undefined =>
  remoteRepoContextArtifacts(run).at(-1);

export const readRemoteRepoContextArtifact = async (
  artifact: RunArtifact
): Promise<GitHubConnectorRepoContext> => {
  const raw = await readFile(artifact.ref, "utf8");
  return JSON.parse(raw) as GitHubConnectorRepoContext;
};

export const readLatestRemoteRepoContext = async (
  run: RunRecord
): Promise<GitHubConnectorRepoContext | undefined> => {
  const artifact = latestRemoteRepoContextArtifact(run);

  return artifact ? readRemoteRepoContextArtifact(artifact) : undefined;
};
