// ─── Pipeline Configuration (derived from Zod schemas in src/schemas.ts) ─────

import type { PipelineConfig } from "./schemas";

export type {
  AppConfig,
  PipelineConfig,
  StepConfig,
  StepType,
} from "./schemas";

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
  configSnapshot?: PipelineConfig; // pipeline config at the time the package was created
  status: "active" | "complete";
}
