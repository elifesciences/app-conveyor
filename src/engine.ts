/**
 * Core polling engine. Iterates all pipeline steps for each active Package.
 */

import {
  findPackageByCommitPrefix,
  getPackage,
  listPackages,
  upsertPackage,
  upsertStepState,
} from "./db";
import { syncFluxImage } from "./modules/flux-image";
import { syncFluxKustomize } from "./modules/flux-kustomize";
import { syncGhPr } from "./modules/gh-pr";
import { syncGha } from "./modules/gha";
import { syncGhcr } from "./modules/ghcr";
import { buildStepState, fetchLatestCommit } from "./modules/git";
import { syncK8sDeploy } from "./modules/k8s-deploy";
import type { Package, PipelineConfig, StepConfig, StepState } from "./types";
import { now } from "./util";

export class Engine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private cfg: PipelineConfig) {}

  start() {
    if (this.running) return;
    this.running = true;
    const interval = this.cfg.pollIntervalMs ?? 60_000;
    this.poll().catch(console.error);
    this.timer = setInterval(() => this.poll().catch(console.error), interval);
    console.log(
      `[engine:${this.cfg.id}] started, polling every ${interval / 1000}s`,
    );
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.running = false;
  }

  async poll() {
    console.log(`[engine:${this.cfg.id}] poll at ${new Date().toISOString()}`);
    await this.discoverNewCommits();
    await this.advancePackages();
  }

  async pollPackage(commitPrefix: string) {
    const pkg = findPackageByCommitPrefix(this.cfg.id, commitPrefix);
    if (!pkg) {
      console.warn(
        `[engine:${this.cfg.id}] pollPackage: no package matching ${commitPrefix}`,
      );
      return;
    }
    console.log(
      `[engine:${this.cfg.id}] pollPackage ${pkg.commitHash.slice(0, 7)} at ${new Date().toISOString()}`,
    );
    await this.advancePackage(pkg);
  }

  // ─── Step 1: discover new commits from Git step ──────────────────────────

  private async discoverNewCommits() {
    const gitSteps = this.cfg.steps.filter((s) => s.type === "git");
    for (const step of gitSteps) {
      console.log(
        `[engine:${this.cfg.id}] git: checking ${step.repo}/${step.branch}`,
      );
      try {
        const commit = await fetchLatestCommit(step);
        if (!commit) {
          console.log(
            `[engine:${this.cfg.id}] git: no commit returned for ${step.repo}/${step.branch}`,
          );
          continue;
        }

        const pkgId = `${this.cfg.id}:${commit.sha}`;
        const existing = getPackage(pkgId);
        if (existing) {
          console.log(
            `[engine:${this.cfg.id}] git: ${commit.sha.slice(0, 7)} already tracked`,
          );
          continue;
        }

        console.log(
          `[engine:${this.cfg.id}] new commit ${commit.sha.slice(0, 7)} on ${step.repo}/${step.branch}: ${commit.message}`,
        );

        const pkg: Omit<Package, "steps"> = {
          id: pkgId,
          pipelineId: this.cfg.id,
          commitHash: commit.sha,
          repoFullName: step.repo ?? "",
          branch: step.branch ?? "",
          authorName: commit.authorName,
          message: commit.message,
          createdAt: now(),
          updatedAt: now(),
          currentStep: 0,
          configSnapshot: this.cfg,
        };
        upsertPackage(pkg);

        const gitState = buildStepState(step, commit);
        upsertStepState(pkgId, gitState);

        for (const s of this.cfg.steps.filter((s2) => s2.type !== "git")) {
          upsertStepState(pkgId, {
            stepId: s.id,
            status: "pending",
            label: "…",
            updatedAt: now(),
          });
        }
      } catch (e) {
        console.error(`[engine:${this.cfg.id}] git discover error:`, e);
      }
    }
  }

  // ─── Step 2: advance all packages through remaining steps ────────────────

  private async advancePackages() {
    const packages = listPackages(this.cfg.id, 100);
    for (const pkg of packages) {
      const allPassed = pkg.steps.every((s) => s.status === "passed");
      if (allPassed) continue;
      await this.advancePackage(pkg);
    }
  }

  async advancePackage(pkg: Package) {
    const pipelineCfg = pkg.configSnapshot ?? this.cfg;
    const stepMap = new Map(pkg.steps.map((s) => [s.stepId, s]));
    const upstream = this.gatherUpstream(
      pkg.steps.filter((s) => s.status === "passed"),
    );

    for (const stepCfg of pipelineCfg.steps) {
      if (stepCfg.type === "git") continue;

      const current = stepMap.get(stepCfg.id);
      if (current?.status === "passed") {
        // propagate this step's outputs for downstream steps
        const s = current;
        if (s.commitHash) upstream.commitHash = s.commitHash;
        if (s.ghaRunId) upstream.ghaRunId = s.ghaRunId;
        if (s.imageDigest) upstream.imageDigest = s.imageDigest;
        if (s.imageTag) upstream.imageTag = s.imageTag;
        if (s.syncRevision) upstream.syncRevision = s.syncRevision;
        continue;
      }

      let newState: StepState;
      try {
        newState = await this.syncStep(stepCfg, upstream);
      } catch (e: unknown) {
        newState = {
          stepId: stepCfg.id,
          status: "failed",
          label: "err",
          detail: e instanceof Error ? e.message : String(e),
          updatedAt: now(),
        };
      }

      console.log(
        `[engine:${this.cfg.id}] ${pkg.commitHash.slice(0, 7)} [${stepCfg.id}] → ${newState.status} (${newState.label})${newState.detail ? ` | ${newState.detail}` : ""}`,
      );
      upsertStepState(pkg.id, newState);

      if (newState.commitHash) upstream.commitHash = newState.commitHash;
      if (newState.ghaRunId) upstream.ghaRunId = newState.ghaRunId;
      if (newState.imageDigest) upstream.imageDigest = newState.imageDigest;
      if (newState.imageTag) upstream.imageTag = newState.imageTag;
      if (newState.syncRevision) upstream.syncRevision = newState.syncRevision;

      if (newState.status === "failed") {
        console.log(
          `[engine:${this.cfg.id}] ${pkg.commitHash.slice(0, 7)} stopped at [${stepCfg.id}]: failed`,
        );
        break;
      }
      if (newState.status === "pending" || newState.status === "running") {
        break;
      }
    }

    upsertPackage({
      id: pkg.id,
      pipelineId: pkg.pipelineId,
      commitHash: pkg.commitHash,
      repoFullName: pkg.repoFullName,
      branch: pkg.branch,
      authorName: pkg.authorName,
      message: pkg.message,
      createdAt: pkg.createdAt,
      updatedAt: now(),
      currentStep: pkg.currentStep,
    });
  }

  private gatherUpstream(steps: StepState[]): {
    commitHash?: string;
    ghaRunId?: string;
    imageDigest?: string;
    imageTag?: string;
    syncRevision?: string;
  } {
    const result: ReturnType<typeof this.gatherUpstream> = {};
    for (const s of steps) {
      if (s.commitHash) result.commitHash = s.commitHash;
      if (s.ghaRunId) result.ghaRunId = s.ghaRunId;
      if (s.imageDigest) result.imageDigest = s.imageDigest;
      if (s.imageTag) result.imageTag = s.imageTag;
      if (s.syncRevision) result.syncRevision = s.syncRevision;
    }
    return result;
  }

  private async syncStep(
    cfg: StepConfig,
    upstream: ReturnType<typeof this.gatherUpstream>,
  ): Promise<StepState> {
    const commitHash = upstream.commitHash ?? "";
    const imageDigest = upstream.imageDigest ?? "";
    const imageTag = upstream.imageTag ?? "";

    switch (cfg.type) {
      case "gha":
        return syncGha(cfg, commitHash);
      case "ghcr":
        return syncGhcr(cfg, commitHash);
      case "gh-pr":
        return syncGhPr(cfg, imageTag);
      case "flux-image":
        return syncFluxImage(cfg, imageTag, imageDigest);
      case "flux-kustomize":
        return syncFluxKustomize(cfg, commitHash, imageTag);
      case "k8s-deploy":
        return syncK8sDeploy(cfg, imageDigest, imageTag);
      default:
        return {
          stepId: cfg.id,
          status: "skipped",
          label: "–",
          detail: `unknown step type: ${(cfg as { type: string }).type}`,
          updatedAt: now(),
        };
    }
  }
}
