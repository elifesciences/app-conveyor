/**
 * GHA Tracker — finds the workflow run triggered by a commit_hash.
 */
import { ghFetch } from "../github";
import type { StepConfig, StepState, StepStatus } from "../types";
import { errorMessage, now } from "../util";

interface GhaRun {
  id: number;
  status: string;
  conclusion: string | null;
}

interface GhaRunsResponse {
  workflow_runs?: GhaRun[];
}

export async function syncGha(
  cfg: StepConfig,
  commitHash: string,
): Promise<StepState> {
  const base: Omit<StepState, "status" | "label" | "detail" | "ghaRunId"> = {
    stepId: cfg.id,
    updatedAt: now(),
    commitHash,
  };

  if (!cfg.repo || !cfg.workflow) {
    return {
      ...base,
      status: "skipped",
      label: "–",
      detail: "workflow not configured",
    };
  }

  try {
    const data = (await ghFetch(
      `/repos/${cfg.repo}/actions/workflows/${cfg.workflow}/runs?head_sha=${commitHash}&per_page=1`,
    )) as GhaRunsResponse;
    const run = data?.workflow_runs?.[0];
    if (!run) {
      return {
        ...base,
        status: "pending",
        label: "waiting",
        detail: "no run found yet",
      };
    }

    const runId = String(run.id);
    const conclusion: string | null = run.conclusion ?? null;
    const runStatus: string = run.status ?? "queued";

    let status: StepStatus;
    if (conclusion === "success") status = "passed";
    else if (conclusion === "failure" || conclusion === "cancelled")
      status = "failed";
    else if (runStatus === "in_progress") status = "running";
    else status = "pending";

    return {
      ...base,
      status,
      label: `#${runId.slice(-6)}`,
      detail: `Run ${runId} — ${runStatus}${conclusion ? ` / ${conclusion}` : ""}`,
      ghaRunId: runId,
    };
  } catch (e: unknown) {
    return { ...base, status: "failed", label: "err", detail: errorMessage(e) };
  }
}
