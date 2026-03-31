import { expect, mock, test } from "bun:test";

// Use in-memory DB
process.env.DB_PATH = ":memory:";

const { upsertPackage, upsertStepState, getPackage } = await import("../db");
const { Engine } = await import("../engine");

import type { PipelineConfig, StepState } from "../types";

const PIPELINE = "test-pipeline";

// Minimal config: one git step + one gha step
const cfg: PipelineConfig = {
  id: PIPELINE,
  name: "Test Pipeline",
  pollIntervalMs: 999_999,
  steps: [
    { id: "src", type: "git", repo: "my-org/app", branch: "main" },
    { id: "ci", type: "gha", repo: "my-org/app", workflow: "deploy.yaml" },
  ],
};

const SHA = "eeee000000000000000000000000000000000001";
const PKG_ID = `${PIPELINE}:${SHA}`;

function seedPackage() {
  upsertPackage({
    id: PKG_ID,
    pipelineId: PIPELINE,
    commitHash: SHA,
    repoFullName: "my-org/app",
    branch: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentStep: 0,
  });
  upsertStepState(PKG_ID, {
    stepId: "src",
    status: "passed",
    label: "eeee000",
    updatedAt: new Date().toISOString(),
    commitHash: SHA,
  });
  upsertStepState(PKG_ID, {
    stepId: "ci",
    status: "pending",
    label: "…",
    updatedAt: new Date().toISOString(),
  });
}

test("engine advances a pending GHA step to passed", async () => {
  seedPackage();

  globalThis.fetch = mock(async (url: string) => {
    if (String(url).includes("/actions/workflows/")) {
      return new Response(
        JSON.stringify({
          workflow_runs: [
            { id: 42, status: "completed", conclusion: "success" },
          ],
        }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof globalThis.fetch;

  const engine = new Engine(cfg);
  await (
    engine as unknown as { advancePackages(): Promise<void> }
  ).advancePackages();

  const pkg = getPackage(PKG_ID);
  if (!pkg) throw new Error("expected package");
  const ciStep = pkg.steps.find((s) => s.stepId === "ci");
  expect(ciStep?.status).toBe("passed");
  expect(ciStep?.ghaRunId).toBe("42");
});

test("engine marks step as failed on API error", async () => {
  seedPackage();

  globalThis.fetch = mock(async () => {
    throw new Error("network timeout");
  }) as unknown as typeof globalThis.fetch;

  const engine = new Engine(cfg);
  await (
    engine as unknown as { advancePackages(): Promise<void> }
  ).advancePackages();

  const pkg = getPackage(PKG_ID);
  if (!pkg) throw new Error("expected package");
  const ciStep = pkg.steps.find((s) => s.stepId === "ci");
  expect(ciStep?.status).toBe("failed");
  expect(ciStep?.detail).toContain("network timeout");
});

test("engine skips already-passed steps", async () => {
  seedPackage();
  upsertStepState(PKG_ID, {
    stepId: "ci",
    status: "passed",
    label: "done",
    updatedAt: new Date().toISOString(),
  });

  let fetchCalled = false;
  globalThis.fetch = mock(async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ workflow_runs: [] }));
  }) as unknown as typeof globalThis.fetch;

  const engine = new Engine(cfg);
  await (
    engine as unknown as { advancePackages(): Promise<void> }
  ).advancePackages();

  expect(fetchCalled).toBe(false);
});

test("gatherUpstream collects IDs from existing steps", () => {
  const steps: StepState[] = [
    {
      stepId: "src",
      status: "passed",
      label: "abc",
      updatedAt: new Date().toISOString(),
      commitHash: SHA,
    },
    {
      stepId: "ci",
      status: "passed",
      label: "#42",
      updatedAt: new Date().toISOString(),
      ghaRunId: "42",
    },
  ];
  const engine = new Engine(cfg);
  const upstream = (
    engine as unknown as {
      gatherUpstream(steps: StepState[]): Record<string, string>;
    }
  ).gatherUpstream(steps);
  expect(upstream.commitHash).toBe(SHA);
  expect(upstream.ghaRunId).toBe("42");
});
