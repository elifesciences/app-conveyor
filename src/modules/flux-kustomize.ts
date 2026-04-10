/**
 * Flux Reconciler — checks if the Kustomization has reconciled the GitOps commit
 * that contains the new image.
 *
 * When the upstream flux-image step resolved an ImageUpdateAutomation push, its
 * push commit arrives here as upstreamPushCommit (via syncRevision). We verify
 * that lastAppliedRevision contains that commit.
 *
 * When no push commit is available (no automation configured), falls back to the
 * imageTag timestamp heuristic: the Kustomization must have transitioned to Ready
 * after the image was built.
 */
import { getKubeClient } from "../kube";
import type { StepConfig, StepState } from "../types";
import { errorMessage, isK8sNotFound, now } from "../util";

interface FluxCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

interface FluxKustomization {
  status?: {
    lastAppliedRevision?: string;
    conditions?: FluxCondition[];
  };
}

export async function syncFluxKustomize(
  cfg: StepConfig,
  commitHash: string,
  imageTag: string,
  upstreamPushCommit?: string,
): Promise<StepState> {
  const base: Omit<StepState, "status" | "label" | "detail"> = {
    stepId: cfg.id,
    updatedAt: now(),
    commitHash,
  };

  if (!cfg.name) {
    return {
      ...base,
      status: "skipped",
      label: "–",
      detail: "kustomization name not configured",
    };
  }

  const namespace = cfg.namespace ?? "flux-system";

  try {
    const client = getKubeClient();
    const customObjects = client.customObjects;

    const ks = (await customObjects.getNamespacedCustomObject({
      group: "kustomize.toolkit.fluxcd.io",
      version: "v1",
      namespace,
      plural: "kustomizations",
      name: cfg.name ?? "",
    })) as FluxKustomization;

    const lastAppliedRevision: string = ks?.status?.lastAppliedRevision ?? "";
    const readyCondition = ks?.status?.conditions?.find(
      (c) => c.type === "Ready",
    );
    const readyStatus: string = readyCondition?.status ?? "Unknown";
    const message: string = readyCondition?.message ?? "";

    const shortRev =
      lastAppliedRevision.split(":").pop()?.slice(0, 7) ??
      lastAppliedRevision.slice(0, 7);

    // DependencyNotReady is always transient — a sibling Kustomization that
    // isn't ready yet. Don't mark failed; it will recover on its own.
    const isDependencyTransient =
      readyCondition?.reason === "DependencyNotReady";

    // ── Push commit path (upstream from flux-image automation) ───────────────
    if (upstreamPushCommit) {
      const pushApplied = lastAppliedRevision.includes(upstreamPushCommit);

      let status: StepState["status"];
      if (readyStatus === "True" && pushApplied) status = "passed";
      else if (readyStatus === "False" && pushApplied && !isDependencyTransient)
        status = "failed";
      else status = "running";

      return {
        ...base,
        status,
        label: shortRev || "…",
        detail: [
          `${cfg.name}: ${lastAppliedRevision}`,
          `push: ${upstreamPushCommit.slice(0, 7)}`,
          pushApplied
            ? "push applied ✓"
            : "waiting for kustomization to apply push commit",
          message,
        ]
          .filter(Boolean)
          .join(" | "),
        syncRevision: lastAppliedRevision,
      };
    }

    // ── Fallback: no push commit — use imageTag timestamp heuristic ──────────
    const imageBuiltAt = parseTagTimestamp(imageTag);
    const conditionTime = new Date(readyCondition?.lastTransitionTime ?? 0);
    const reconciledAfterImage =
      imageBuiltAt === null || conditionTime >= imageBuiltAt;

    let status: StepState["status"];
    if (readyStatus === "True" && reconciledAfterImage) status = "passed";
    else if (readyStatus === "False" && !isDependencyTransient)
      status = "failed";
    else status = "running";

    return {
      ...base,
      status,
      label: shortRev || "…",
      detail: `${cfg.name}: ${lastAppliedRevision} | ${message}`,
      syncRevision: lastAppliedRevision,
    };
  } catch (e: unknown) {
    if (isK8sNotFound(e)) {
      return {
        ...base,
        status: "pending",
        label: "waiting",
        detail: `Kustomization ${cfg.name} not found`,
      };
    }
    return { ...base, status: "failed", label: "err", detail: errorMessage(e) };
  }
}

/**
 * Parses the build timestamp from a tag like "master-33ac119d-20260330.1203".
 * Returns null if the format isn't recognised.
 */
function parseTagTimestamp(imageTag: string): Date | null {
  const m = imageTag.match(/-(\d{8})\.(\d{4})(?:-|$)/);
  if (!m?.[1] || !m[2]) return null;
  const iso = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:00Z`;
  return new Date(iso);
}
