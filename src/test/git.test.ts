import { expect, test } from "bun:test";
import { buildStepState } from "../modules/git";
import type { StepConfig } from "../types";

const gitCfg: StepConfig = {
  id: "src",
  type: "git",
  repo: "my-org/app",
  branch: "main",
};

test("buildStepState produces a passed step with short hash", () => {
  const commit = {
    sha: "abc1234def5678901234567890123456789abcde",
    authorName: "Dev",
    message: "fix: typo",
  };
  const state = buildStepState(gitCfg, commit);
  expect(state.status).toBe("passed");
  expect(state.label).toBe("abc1234");
  expect(state.commitHash).toBe(commit.sha);
  expect(state.detail).toContain("Dev");
  expect(state.detail).toContain("fix: typo");
});

test("fetchLatestCommit returns null when repo/branch missing", async () => {
  const { fetchLatestCommit } = await import("../modules/git");
  const result = await fetchLatestCommit({ id: "src", type: "git" }).catch(
    () => null,
  );
  expect(result).toBeNull();
});
