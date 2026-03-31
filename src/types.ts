// ─── Pipeline Configuration ──────────────────────────────────────────────────

export type StepType =
  | "git"
  | "gha"
  | "ghcr"
  | "gh-pr"
  | "flux-image"
  | "flux-kustomize"
  | "k8s-deploy";

export interface StepConfig {
  id: string;
  type: StepType;
  // git
  repo?: string;
  branch?: string;
  // gha
  workflow?: string;
  // ghcr
  image?: string;
  // gh-pr
  author?: string; // filter PRs by author, e.g. "renovate[bot]"
  // flux-image
  policy?: string;
  imageRepository?: string;
  // flux-kustomize
  name?: string;
  automation?: string; // ImageUpdateAutomation resource name
  // k8s-deploy
  namespace?: string;
  deployment?: string;
}

export interface PipelineConfig {
  id: string;
  name: string;
  pollIntervalMs?: number;
  steps: StepConfig[];
}

export interface AppConfig {
  pipelines: PipelineConfig[];
}

// ─── Package / Artifact ──────────────────────────────────────────────────────

export type StepStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped";

export interface StepState {
  stepId: string;
  status: StepStatus;
  label: string; // e.g. short commit hash, run ID, digest suffix
  detail?: string; // longer tooltip / description
  updatedAt: string; // ISO timestamp
  // IDs propagated downstream
  commitHash?: string;
  ghaRunId?: string;
  imageDigest?: string;
  imageTag?: string;
  syncRevision?: string;
}

export interface StepHistoryEntry {
  id: number;
  package_id: string;
  step_id: string;
  status: string;
  label: string;
  detail: string | null;
  recorded_at: string;
}

export interface Package {
  id: string; // "{pipelineId}:{commitHash}"
  pipelineId: string;
  commitHash: string;
  repoFullName: string;
  branch: string;
  authorName?: string;
  message?: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  steps: StepState[];
  currentStep: number;
}
