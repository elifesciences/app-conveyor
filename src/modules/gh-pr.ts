/**
 * GitHub Pull Request — finds a PR (typically opened by Renovate) in a
 * configured repo that references the current image tag, checks its CI
 * status, and passes when the PR is merged.
 *
 * The short commit hash embedded in the imageTag (e.g. "33ac119d" from
 * "master-33ac119d-20260330.1203") is used to identify the matching PR by
 * searching its title and head branch name.
 */
import type { StepConfig, StepState } from "../types";
import { now } from "../util";

const GITHUB_API = "https://api.github.com";

export async function syncGhPr(
  cfg: StepConfig,
  imageTag: string
): Promise<StepState> {
  const base: Omit<StepState, "status" | "label" | "detail"> = {
    stepId: cfg.id,
    updatedAt: now(),
    imageTag,
  };

  if (!cfg.repo) {
    return { ...base, status: "skipped", label: "–", detail: "repo not configured" };
  }

  if (!imageTag) {
    return { ...base, status: "pending", label: "waiting", detail: "waiting for image tag from registry step" };
  }

  const shortHash = extractShortHash(imageTag);
  if (!shortHash) {
    return { ...base, status: "pending", label: "waiting", detail: `could not extract hash from tag: ${imageTag}` };
  }

  const pat = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (pat) headers["Authorization"] = `Bearer ${pat}`;

  try {
    // Fetch recent PRs (open + closed) and find one matching our hash
    const url = `${GITHUB_API}/repos/${cfg.repo}/pulls?state=all&per_page=50&sort=created&direction=desc`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      return { ...base, status: "failed", label: "err", detail: `GitHub API ${res.status} for ${url}` };
    }

    const prs: any[] = await res.json();
    const authorFilter = cfg.author;

    const pr = prs.find(p => {
      if (authorFilter && p.user?.login !== authorFilter) return false;
      return (
        (p.title as string).includes(shortHash) ||
        (p.head?.ref as string).includes(shortHash)
      );
    });

    if (!pr) {
      return {
        ...base,
        status: "pending",
        label: "waiting",
        detail: `no PR found in ${cfg.repo} referencing ${shortHash}`,
      };
    }

    const prLabel = `#${pr.number}`;

    // PR was closed without merging
    if (pr.state === "closed" && !pr.merged_at) {
      return {
        ...base,
        status: "failed",
        label: prLabel,
        detail: `PR ${prLabel} closed without merging: ${pr.title}`,
      };
    }

    // PR is merged — passed
    if (pr.merged_at) {
      return {
        ...base,
        status: "passed",
        label: prLabel,
        detail: `PR ${prLabel} merged: ${pr.title}`,
      };
    }

    // PR is open — check CI status on the head commit
    const checksUrl = `${GITHUB_API}/repos/${cfg.repo}/commits/${pr.head.sha}/check-runs?per_page=100`;
    const checksRes = await fetch(checksUrl, { headers });

    if (!checksRes.ok) {
      // Can't get checks — report PR as open/running
      return {
        ...base,
        status: "running",
        label: prLabel,
        detail: `PR ${prLabel} open | ${pr.title} | checks unavailable`,
      };
    }

    const checksData: any = await checksRes.json();
    const runs: any[] = checksData.check_runs ?? [];

    const failed = runs.filter(r => r.conclusion === "failure" || r.conclusion === "cancelled");
    const pending = runs.filter(r => r.status !== "completed");

    if (failed.length > 0) {
      return {
        ...base,
        status: "failed",
        label: prLabel,
        detail: `PR ${prLabel} | ${failed.length} check(s) failed: ${failed.map((r: any) => r.name).join(", ")}`,
      };
    }

    return {
      ...base,
      status: "running",
      label: prLabel,
      detail: `PR ${prLabel} open | ${pending.length} check(s) pending | ${pr.title}`,
    };
  } catch (e: any) {
    return { ...base, status: "failed", label: "err", detail: String(e?.message ?? e) };
  }
}

/**
 * Extracts the short commit hash from a tag like "master-33ac119d-20260330.1203".
 * Returns null if the format isn't recognised.
 */
function extractShortHash(imageTag: string): string | null {
  // Format: {branch}-{hash}-{YYYYMMDD}.{HHMM}
  const m = imageTag.match(/^[^-]+-([a-f0-9]{7,40})-\d{8}\.\d{4}/);
  return m?.[1] ?? null;
}
