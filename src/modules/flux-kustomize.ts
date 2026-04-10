/**
 * Flux Reconciler — checks if the Kustomization has reconciled the GitOps commit
 * that contains the new image.
 *
 * When an ImageUpdateAutomation is configured:
 *   1. Query it for status.lastPushCommit and status.lastPushTime.
 *   2. Guard: lastPushTime must be >= the image build time (parsed from imageTag)
 *      so a stale push from a previous deploy doesn't cause a false pass.
 *   3. Pass: Kustomization is Ready AND lastAppliedRevision contains lastPushCommit.
 *
 * lastTransitionTime is used as a fallback when exact commit match fails: if
 * the kustomization transitioned to Ready after the push time, a concurrent
 * GitOps commit has superseded the push and the change is included. Note this
 * fallback does not help for kustomizations that stay continuously Ready across
 * reconciliations — exact commit match remains the reliable path for those.
 *
 * Without automation configured, falls back to the imageTag timestamp heuristic.
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

interface FluxAutomation {
  status?: {
    lastPushTime?: string;
    lastPushCommit?: string;
  };
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

    // ── 1. ImageUpdateAutomation (optional) ──────────────────────────────────
    let lastPushTime: Date | null = null;
    let lastPushCommit: string | undefined;

    if (cfg.automation) {
      try {
        const automation = (await customObjects.getNamespacedCustomObject({
          group: "image.toolkit.fluxcd.io",
          version: "v1beta2",
          namespace,
          plural: "imageupdateautomations",
          name: cfg.automation,
        })) as FluxAutomation;

        const rawPushTime: string | undefined =
          automation?.status?.lastPushTime;
        lastPushCommit = automation?.status?.lastPushCommit;
        if (rawPushTime) lastPushTime = new Date(rawPushTime);
      } catch (e: unknown) {
        if (isK8sNotFound(e)) {
          return {
            ...base,
            status: "pending",
            label: "waiting",
            detail: `ImageUpdateAutomation ${cfg.automation} not found`,
          };
        }
        throw e;
      }
    }

    // ── 2. Kustomization ─────────────────────────────────────────────────────
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

    // ── 3. Automation path ────────────────────────────────────────────────────
    if (cfg.automation) {
      if (!lastPushTime || !lastPushCommit) {
        return {
          ...base,
          status: "running",
          label: "…",
          detail: `${cfg.automation}: no push recorded yet`,
          syncRevision: lastAppliedRevision,
        };
      }

      // Guard: push must be for our image (or newer), not a stale previous push.
      const imageBuiltAt = parseTagTimestamp(imageTag);
      if (imageBuiltAt && lastPushTime < imageBuiltAt) {
        return {
          ...base,
          status: "running",
          label: lastPushCommit.slice(0, 7),
          detail: `${cfg.automation}: waiting for push (last: ${lastPushTime.toISOString()} < image built: ${imageBuiltAt.toISOString()})`,
          syncRevision: lastAppliedRevision,
        };
      }

      // Pass if the kustomization has applied the exact push commit, OR if it
      // has reconciled to a newer commit that supersedes it. The latter happens
      // when multiple pipelines share a GitOps repo: Flux reconciles to the
      // latest HEAD rather than the specific commit the automation pushed.
      // We detect this by checking if the kustomization transitioned to Ready
      // after the push was made.
      const pushApplied = lastAppliedRevision.includes(lastPushCommit);
      const reconciledAfterPush =
        !!readyCondition?.lastTransitionTime &&
        new Date(readyCondition.lastTransitionTime) >= lastPushTime;
      const pushSatisfied = pushApplied || reconciledAfterPush;

      // DependencyNotReady is always transient — a sibling Kustomization that
      // isn't ready yet. Don't mark failed even if pushApplied; it will recover.
      const isDependencyTransient =
        readyCondition?.reason === "DependencyNotReady";

      let status: StepState["status"];
      if (readyStatus === "True" && pushSatisfied) status = "passed";
      else if (readyStatus === "False" && pushApplied && !isDependencyTransient)
        status = "failed";
      else status = "running";

      return {
        ...base,
        status,
        label: shortRev || "…",
        detail: [
          `${cfg.name}: ${lastAppliedRevision}`,
          `push: ${lastPushCommit.slice(0, 7)}`,
          pushApplied
            ? "push applied ✓"
            : reconciledAfterPush
              ? "reconciled after push ✓"
              : "waiting for kustomization to apply push commit",
          message,
        ]
          .filter(Boolean)
          .join(" | "),
        syncRevision: lastAppliedRevision,
      };
    }

    // ── 4. Fallback: no automation configured — use imageTag timestamp ─────────
    const imageBuiltAt = parseTagTimestamp(imageTag);
    const conditionTime = new Date(readyCondition?.lastTransitionTime ?? 0);
    const reconciledAfterImage =
      imageBuiltAt === null || conditionTime >= imageBuiltAt;

    const isDependencyTransient =
      readyCondition?.reason === "DependencyNotReady";

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
