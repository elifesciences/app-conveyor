import { expect, mock, test } from "bun:test";
import type { StepConfig } from "../types";

const cfg: StepConfig = {
  id: "ci",
  type: "gha",
  repo: "my-org/app",
  workflow: "deploy.yaml",
};
const sha = "abc1234def5678901234567890123456789abcde";

// Intercept fetch before importing the module
const fetchMock = mock(async (url: string) => {
  if (url.includes("/actions/workflows/")) {
    return new Response(
      JSON.stringify({
        workflow_runs: [
          {
            id: 9876543,
            status: "completed",
            conclusion: "success",
          },
        ],
      }),
    );
  }
  throw new Error(`unexpected fetch: ${url}`);
});

globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

const { syncGha } = await import("../modules/gha");

test("syncGha returns passed when conclusion=success", async () => {
  const state = await syncGha(cfg, sha);
  expect(state.status).toBe("passed");
  expect(state.ghaRunId).toBe("9876543");
  expect(state.label).toContain("876543");
});

test("syncGha returns skipped when workflow not configured", async () => {
  const noWf: StepConfig = { id: "ci", type: "gha" };
  const state = await syncGha(noWf, sha);
  expect(state.status).toBe("skipped");
});

test("syncGha returns pending when no runs found", async () => {
  const emptyFetch = mock(
    async () => new Response(JSON.stringify({ workflow_runs: [] })),
  );
  globalThis.fetch = emptyFetch as unknown as typeof globalThis.fetch;

  const { syncGha: syncGha2 } = await import("../modules/gha");
  const state = await syncGha2(cfg, sha);
  expect(state.status).toBe("pending");
});
