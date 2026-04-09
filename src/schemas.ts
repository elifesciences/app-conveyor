import { z } from "zod";

export const StepTypeSchema = z.enum([
  "git",
  "gha",
  "ghcr",
  "gh-pr",
  "flux-image",
  "flux-kustomize",
  "k8s-deploy",
]);

export const StepConfigSchema = z.object({
  id: z.string(),
  type: StepTypeSchema,
  label: z.string().optional(), // overrides the default column heading in the UI
  // git
  repo: z.string().optional(),
  branch: z.string().optional(),
  // gha
  workflow: z.string().optional(),
  // ghcr
  image: z.string().optional(),
  tagPattern: z.string().optional(),
  // gh-pr
  author: z.string().optional(),
  // flux-image
  policy: z.string().optional(),
  imageRepository: z.string().optional(),
  // flux-kustomize
  name: z.string().optional(),
  automation: z.string().optional(),
  // k8s-deploy
  namespace: z.string().optional(),
  deployment: z.string().optional(), // deprecated — use name
  kind: z.enum(["Deployment", "StatefulSet"]).optional(),
});

export const PipelineConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  pollIntervalMs: z.number().int().min(1).optional(),
  steps: z.array(StepConfigSchema).min(1),
});

export const AppConfigSchema = z.object({
  pipelines: z.array(PipelineConfigSchema).min(1),
});

// Inferred TypeScript types — use these instead of writing interfaces by hand
export type StepType = z.infer<typeof StepTypeSchema>;
export type StepConfig = z.infer<typeof StepConfigSchema>;
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
