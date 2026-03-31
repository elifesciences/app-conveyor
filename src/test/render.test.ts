/// <reference lib="dom" />

import { expect, test } from "bun:test";
import { renderDashboard, renderPackageDetail } from "../render";
import type { Package, PipelineConfig } from "../types";

const cfg: PipelineConfig = {
  id: "test-pipeline",
  name: "Test App",
  steps: [
    { id: "src", type: "git", repo: "my-org/app", branch: "main" },
    { id: "ci", type: "gha", workflow: "deploy.yaml" },
    { id: "reg", type: "ghcr", image: "ghcr.io/my-org/app" },
  ],
};

function makePkg(overrides: Partial<Package> = {}): Package {
  return {
    id: "abc1234abc1234abc1234abc1234abc1234abc123",
    pipelineId: "test-pipeline",
    commitHash: "abc1234abc1234abc1234abc1234abc1234abc123",
    repoFullName: "my-org/app",
    branch: "main",
    authorName: "Dev",
    message: "feat: add feature",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentStep: 1,
    steps: [
      {
        stepId: "src",
        status: "passed",
        label: "abc1234",
        updatedAt: new Date().toISOString(),
        commitHash: "abc1234abc1234abc1234abc1234abc1234abc123",
      },
      {
        stepId: "ci",
        status: "running",
        label: "#123456",
        updatedAt: new Date().toISOString(),
      },
      {
        stepId: "reg",
        status: "pending",
        label: "…",
        updatedAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

// ─── renderDashboard ──────────────────────────────────────────────────────────

test("renderDashboard sets page title to pipeline name", () => {
  const doc = parse(
    renderDashboard([makePkg()], cfg, new Date("2025-01-01T12:00:00Z")),
  );
  expect(doc.title).toBe("Test App — App Conveyor");
});

test("renderDashboard renders pipeline name in the header", () => {
  const doc = parse(renderDashboard([makePkg()], cfg, new Date()));
  const h1 = doc.querySelector("h1");
  expect(h1?.textContent).toContain("Test App");
});

test("renderDashboard renders non-git steps as column headers only", () => {
  const doc = parse(renderDashboard([makePkg()], cfg, new Date()));
  const labels = Array.from(doc.querySelectorAll(".belt-col-label")).map((el) =>
    el.textContent?.trim(),
  );
  expect(labels).toEqual(["Build", "Image Ready"]);
});

test("renderDashboard renders commit short hash in the meta column", () => {
  const doc = parse(renderDashboard([makePkg()], cfg, new Date()));
  expect(doc.querySelector(".commit")?.textContent).toBe("abc1234");
});

test("renderDashboard renders commit message in the meta column", () => {
  const doc = parse(renderDashboard([makePkg()], cfg, new Date()));
  expect(doc.querySelector(".msg")?.textContent).toBe("feat: add feature");
});

test("renderDashboard links each row to the package detail page", () => {
  const doc = parse(renderDashboard([makePkg()], cfg, new Date()));
  const row = doc.querySelector(".package-row");
  expect(row?.getAttribute("href")).toBe(
    "/pipeline/test-pipeline/package/abc1234",
  );
});

test("renderDashboard renders running step with correct badge and status class", () => {
  const doc = parse(renderDashboard([makePkg()], cfg, new Date()));
  const runningCell = doc.querySelector(".step-cell.running");
  expect(runningCell).not.toBeNull();
  expect(runningCell?.querySelector(".step-badge")?.textContent).toBe("Run");
  expect(runningCell?.querySelector(".step-value")?.textContent).toBe(
    "#123456",
  );
});

test("renderDashboard renders pending step with correct badge and status class", () => {
  const doc = parse(renderDashboard([makePkg()], cfg, new Date()));
  const pendingCell = doc.querySelector(".step-cell.pending");
  expect(pendingCell).not.toBeNull();
  expect(pendingCell?.querySelector(".step-badge")?.textContent).toBe("Wait");
});

test("renderDashboard shows empty-state element when no packages", () => {
  const doc = parse(renderDashboard([], cfg, new Date()));
  const empty = doc.querySelector(".empty-state");
  expect(empty).not.toBeNull();
  expect(empty?.textContent).toContain("No commits tracked yet");
  // No package rows should be rendered
  expect(doc.querySelectorAll(".package-row").length).toBe(0);
});

test("renderDashboard escapes HTML in commit message", () => {
  const pkg = makePkg({ message: "<script>alert('xss')</script>" });
  const doc = parse(renderDashboard([pkg], cfg, new Date()));
  // The msg element's textContent should be the literal string, not executed HTML
  expect(doc.querySelector(".msg")?.textContent).toBe(
    "<script>alert('xss')</script>",
  );
  // No actual script element should exist in the DOM
  expect(doc.querySelector("script[src]")).toBeNull();
});

test("renderDashboard escapes HTML in step tooltip", () => {
  const pkg = makePkg({
    steps: [
      {
        stepId: "ci",
        status: "running",
        label: "run",
        updatedAt: new Date().toISOString(),
        detail: "<b>dangerous</b>",
      },
    ],
  });
  const doc = parse(renderDashboard([pkg], cfg, new Date()));
  const cell = doc.querySelector(".step-cell.running");
  // The title attribute should contain the raw text, not a parsed element
  expect(cell?.getAttribute("title")).toContain("<b>dangerous</b>");
  expect(doc.querySelector("b")).toBeNull();
});

// ─── renderPackageDetail ──────────────────────────────────────────────────────

test("renderPackageDetail sets page title with commit hash and pipeline name", () => {
  const doc = parse(renderPackageDetail(makePkg(), cfg, []));
  expect(doc.title).toBe("abc1234 — Test App — App Conveyor");
});

test("renderPackageDetail breadcrumb contains links to landing page and pipeline", () => {
  const doc = parse(renderPackageDetail(makePkg(), cfg, []));
  const links = Array.from(doc.querySelectorAll("h1 a")).map((a) =>
    a.getAttribute("href"),
  );
  expect(links).toContain("/");
  expect(links).toContain("/pipeline/test-pipeline");
});

test("renderPackageDetail shows commit message", () => {
  const doc = parse(renderPackageDetail(makePkg(), cfg, []));
  const body = doc.body.textContent ?? "";
  expect(body).toContain("feat: add feature");
});

test("renderPackageDetail renders a section for each non-git step", () => {
  const doc = parse(renderPackageDetail(makePkg(), cfg, []));
  const sections = doc.querySelectorAll(".step-detail");
  // git step is excluded; ci and reg should each have a section
  expect(sections.length).toBe(2);
});

test("renderPackageDetail renders history rows inside the history table", () => {
  const history = [
    {
      id: 1,
      package_id: "test-pipeline:abc1234abc1234abc1234abc1234abc1234abc123",
      step_id: "ci",
      status: "running",
      label: "#123",
      detail: "in progress",
      recorded_at: "2025-01-01T10:00:00Z",
    },
    {
      id: 2,
      package_id: "test-pipeline:abc1234abc1234abc1234abc1234abc1234abc123",
      step_id: "ci",
      status: "passed",
      label: "#123",
      detail: "done",
      recorded_at: "2025-01-01T10:05:00Z",
    },
  ];
  const doc = parse(renderPackageDetail(makePkg(), cfg, history));
  const rows = Array.from(doc.querySelectorAll(".hist-table tbody tr"));
  expect(rows.length).toBe(2);
  const cellTexts = rows.map((r) =>
    Array.from(r.querySelectorAll("td")).map((td) => td.textContent),
  );
  expect(cellTexts[0]).toContain("running");
  expect(cellTexts[0]).toContain("in progress");
  expect(cellTexts[1]).toContain("passed");
  expect(cellTexts[1]).toContain("done");
});
