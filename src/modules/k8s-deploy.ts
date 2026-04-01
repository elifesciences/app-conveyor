/**
 * K8s Deployment Ready — checks readyReplicas == replicas and image digest matches.
 */
import { getKubeClient } from "../kube";
import type { StepConfig, StepState } from "../types";
import { errorMessage, isK8sNotFound, now } from "../util";

export async function syncK8sDeploy(
  cfg: StepConfig,
  imageDigest: string,
  imageTag: string,
): Promise<StepState> {
  const base: Omit<StepState, "status" | "label" | "detail"> = {
    stepId: cfg.id,
    updatedAt: now(),
    imageDigest,
  };

  const deployName = cfg.name ?? cfg.deployment;
  if (!deployName) {
    return {
      ...base,
      status: "skipped",
      label: "–",
      detail: "deployment name not configured",
    };
  }

  const namespace = cfg.namespace ?? "default";
  const kind = cfg.kind ?? "Deployment";

  try {
    const client = getKubeClient();

    const resource =
      kind === "StatefulSet"
        ? await client.appsV1.readNamespacedStatefulSet({
            name: deployName,
            namespace,
          })
        : await client.appsV1.readNamespacedDeployment({
            name: deployName,
            namespace,
          });

    const desired = resource.spec?.replicas ?? 1;
    const total = resource.status?.replicas ?? 0;
    const updated = resource.status?.updatedReplicas ?? 0;
    // Deployments use availableReplicas; StatefulSets use readyReplicas
    const ready =
      kind === "StatefulSet"
        ? (resource.status?.readyReplicas ?? 0)
        : (resource.status?.availableReplicas ?? 0);

    if (!imageDigest) {
      return {
        ...base,
        status: "pending",
        label: "waiting",
        detail: "waiting for image digest from registry step",
      };
    }

    const specImages =
      resource.spec?.template?.spec?.containers?.map((c) => c.image ?? "") ??
      [];

    // imageTag may be a full 40-char SHA while the spec image reference embeds
    // only the short 7-char prefix (e.g. "gab12d92" in a trunkver tag), so
    // also check the short prefix.
    const shortHash = imageTag ? imageTag.slice(0, 7) : "";
    const imageMatches = (img: string) =>
      img.includes(imageDigest) ||
      img.endsWith(`@${imageDigest}`) ||
      (imageTag ? img.includes(imageTag) : false) ||
      (shortHash ? img.includes(shortHash) : false);

    const imageConfirmed = specImages.some(imageMatches);

    // Rollout is complete when:
    //   - all pods have been updated to the new template (updatedReplicas >= desired)
    //   - all updated pods are ready (ready >= desired)
    //   - no old pods are still terminating (total <= desired)
    const rolloutComplete =
      updated >= desired && ready >= desired && total <= desired && desired > 0;
    const passed = rolloutComplete && imageConfirmed;

    return {
      ...base,
      status: passed ? "passed" : "running",
      label: `${updated}/${desired}`,
      detail: [
        `${kind}/${deployName}: ${updated}/${desired} updated`,
        `ready: ${ready}`,
        `total: ${total}`,
        `images: ${specImages.join(", ")}`,
        imageConfirmed
          ? "image ✓"
          : `image mismatch (want ${imageDigest.slice(7, 19)})`,
      ].join(" | "),
    };
  } catch (e: unknown) {
    if (isK8sNotFound(e)) {
      return {
        ...base,
        status: "pending",
        label: "waiting",
        detail: `${kind} ${deployName} not found`,
      };
    }
    return { ...base, status: "failed", label: "err", detail: errorMessage(e) };
  }
}
