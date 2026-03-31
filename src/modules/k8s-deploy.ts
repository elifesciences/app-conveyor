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

  try {
    const client = getKubeClient();
    const appsV1 = client.appsV1;

    const deploy = await appsV1.readNamespacedDeployment({
      name: deployName,
      namespace,
    });

    const desired = deploy.spec?.replicas ?? 1;
    const total = deploy.status?.replicas ?? 0;
    const updated = deploy.status?.updatedReplicas ?? 0;
    const available = deploy.status?.availableReplicas ?? 0;

    if (!imageDigest) {
      return {
        ...base,
        status: "pending",
        label: "waiting",
        detail: "waiting for image digest from registry step",
      };
    }

    // spec.template.spec.containers[].image confirms this Deployment targets our image.
    // We still check the spec (not pod status) for the image reference — but we use
    // updatedReplicas/availableReplicas to confirm the rollout has actually completed.
    const specImages =
      deploy.spec?.template?.spec?.containers?.map((c) => c.image ?? "") ?? [];

    const imageMatches = (img: string) =>
      img.includes(imageDigest) ||
      img.endsWith(`@${imageDigest}`) ||
      (imageTag ? img.includes(imageTag) : false);

    const imageConfirmed = specImages.some(imageMatches);

    // Rollout is complete when:
    //   - all pods have been updated to the new template (updatedReplicas >= desired)
    //   - all updated pods are available (availableReplicas >= desired)
    //   - no old pods are still terminating (total <= desired)
    const rolloutComplete =
      updated >= desired &&
      available >= desired &&
      total <= desired &&
      desired > 0;
    const passed = rolloutComplete && imageConfirmed;

    return {
      ...base,
      status: passed ? "passed" : "running",
      label: `${updated}/${desired}`,
      detail: [
        `${deployName}: ${updated}/${desired} updated`,
        `available: ${available}`,
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
        detail: `Deployment ${deployName} not found`,
      };
    }
    return { ...base, status: "failed", label: "err", detail: errorMessage(e) };
  }
}
