/**
 * Git Monitor — polls a GitHub branch for new commits.
 * Creates a new Package for each unseen commit_hash.
 */

import { ghFetch } from "../github";
import type { StepConfig, StepState } from "../types";
import { now } from "../util";

interface GithubBranch {
  commit?: {
    sha?: string;
    commit?: {
      author?: { name?: string };
      message?: string;
    };
  };
}

export interface GitCommit {
  sha: string;
  authorName: string;
  message: string;
}

export async function fetchLatestCommit(
  cfg: StepConfig,
): Promise<GitCommit | null> {
  if (!cfg.repo || !cfg.branch) {
    console.warn(`[git] step missing repo/branch config`);
    return null;
  }
  // Let errors propagate so the engine can log them
  const data = (await ghFetch(
    `/repos/${cfg.repo}/branches/${cfg.branch}`,
  )) as GithubBranch;
  const commit = data?.commit;
  if (!commit?.sha) return null;
  return {
    sha: commit.sha as string,
    authorName: (commit.commit?.author?.name as string) ?? "unknown",
    message: (commit.commit?.message as string)?.split("\n")[0] ?? "",
  };
}

export function buildStepState(cfg: StepConfig, commit: GitCommit): StepState {
  return {
    stepId: cfg.id,
    status: "passed",
    label: commit.sha.slice(0, 7),
    detail: `${commit.authorName}: ${commit.message}`,
    updatedAt: now(),
    commitHash: commit.sha,
  };
}
