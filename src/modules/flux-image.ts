/**
 * Flux Automation — checks if Flux ImagePolicy has picked up the new tag.
 */
import { getKubeClient } from "../kube";
import type { StepConfig, StepState } from "../types";
import { errorMessage, isK8sNotFound, now } from "../util";

interface FluxCondition {
  type: string;
  status: string;
  message?: string;
}

interface FluxImagePolicy {
  status?: {
    latestRef?: { tag?: string };
    conditions?: FluxCondition[];
  };
}

export async function syncFluxImage(
  cfg: StepConfig,
  imageTag: string,
  imageDigest: string,
): Promise<StepState> {
  const base: Omit<StepState, "status" | "label" | "detail"> = {
    stepId: cfg.id,
    updatedAt: now(),
    imageTag,
    imageDigest,
  };

  if (!cfg.policy) {
    return {
      ...base,
      status: "skipped",
      label: "–",
      detail: "policy not configured",
    };
  }

  const namespace = cfg.namespace ?? "flux-system";

  try {
    const client = getKubeClient();
    const customObjects = client.customObjects;

    const policy = (await customObjects.getNamespacedCustomObject({
      group: "image.toolkit.fluxcd.io",
      version: "v1beta2",
      namespace,
      plural: "imagepolicies",
      name: cfg.policy,
    })) as FluxImagePolicy;

    // v1beta2 ImagePolicy: status.latestRef.tag holds the selected tag
    const latestTag: string = policy?.status?.latestRef?.tag ?? "";
    const ready = policy?.status?.conditions?.find((c) => c.type === "Ready");

    if (!latestTag) {
      return {
        ...base,
        status: "pending",
        label: "waiting",
        detail: "no latestRef yet",
      };
    }
    if (!imageTag) {
      return {
        ...base,
        status: "pending",
        label: "waiting",
        detail: "waiting for image tag from registry step",
      };
    }

    // Check if the policy has selected our tag (or a tag containing our hash)
    const tagMatches = latestTag === imageTag || latestTag.includes(imageTag);

    return {
      ...base,
      status: tagMatches ? "passed" : "running",
      label: latestTag.slice(0, 12),
      detail: `latestRef.tag: ${latestTag} | ${ready?.message ?? ""}`,
    };
  } catch (e: unknown) {
    if (isK8sNotFound(e)) {
      return {
        ...base,
        status: "pending",
        label: "waiting",
        detail: `ImagePolicy ${cfg.policy} not found`,
      };
    }
    return { ...base, status: "failed", label: "err", detail: errorMessage(e) };
  }
}
