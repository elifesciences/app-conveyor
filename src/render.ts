import type {
  Package,
  PipelineConfig,
  StepConfig,
  StepHistoryEntry,
  StepState,
} from "./types";
import { relativeTime } from "./util";

// ─── Status helpers ────────────────────────────────────────────────────────

const STATUS_CLASS: Record<string, string> = {
  passed: "passed",
  failed: "failed",
  running: "running",
  pending: "pending",
  skipped: "skipped",
  superseded: "superseded",
};

const STATUS_LABEL: Record<string, string> = {
  passed: "Pass",
  failed: "Fail",
  running: "Run",
  pending: "Wait",
  skipped: "Skip",
  superseded: "Old",
};

const STEP_TYPE_LABEL: Record<string, string> = {
  git: "Commit",
  gha: "Build",
  ghcr: "Image Ready",
  "gh-pr": "PR Merged",
  "flux-image": "Flux Update",
  "flux-kustomize": "Flux Sync",
  "k8s-deploy": "Deploy Ready",
};

function stepLabel(cfg: StepConfig): string {
  return cfg.label ?? STEP_TYPE_LABEL[cfg.type] ?? cfg.type;
}

/** Derives an overall status from a package's steps for the landing page summary. */
function packageOverallStatus(pkg: Package): string {
  if (pkg.status === "superseded") return "superseded";
  const statuses = pkg.steps.map((s) => s.status);
  if (statuses.every((s) => s === "passed" || s === "skipped")) return "passed";
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "running")) return "running";
  return "pending";
}

// ─── CSS ──────────────────────────────────────────────────────────────────

const CSS = `
:root {
  --bg: #0d1117;
  --surface: #161b22;
  --border: #30363d;
  --text: #e6edf3;
  --muted: #8b949e;
  --passed: #3fb950;
  --failed: #f85149;
  --running: #d29922;
  --pending: #388bfd;
  --skipped: #6e7681;
  --superseded: #6e4f9e;
  font-size: 13px;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  padding: 1.5rem;
  min-height: 100vh;
}

header {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  margin-bottom: 1.5rem;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.75rem;
}

header h1 { font-size: 1rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
header .subtitle { color: var(--muted); font-size: 0.8rem; }
header .refresh-hint { margin-left: auto; color: var(--muted); font-size: 0.75rem; }

.sync-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
  font-family: inherit;
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.sync-btn:hover { border-color: #58a6ff; color: #58a6ff; }
.sync-btn.warn:hover { border-color: var(--running); color: var(--running); }
.sync-btn.danger:hover { border-color: var(--failed); color: var(--failed); }

/* ── Landing page pipeline cards ── */
.pipeline-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.pipeline-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.75rem 1rem;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.2s;
}

.pipeline-card:hover { border-color: #58a6ff; }

.pipeline-card .pipeline-name {
  font-weight: 600;
  font-size: 0.85rem;
  min-width: 200px;
}

.pipeline-card .pipeline-last {
  font-size: 0.75rem;
  color: var(--muted);
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pipeline-card .pipeline-last .commit-ref {
  color: #58a6ff;
  font-weight: 700;
  margin-right: 0.5rem;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.passed  { background: var(--passed); }
.status-dot.failed  { background: var(--failed); }
.status-dot.running { background: var(--running); }
.status-dot.pending { background: var(--pending); }
.status-dot.skipped    { background: var(--skipped); }
.status-dot.superseded { background: var(--superseded); }

/* ── Belt header (step column labels) ── */
.belt-header {
  display: grid;
  gap: 0;
  margin-bottom: 0.5rem;
  padding: 0 0.5rem;
}

.belt-col-label {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  text-align: center;
  padding: 0.25rem 0;
}

/* ── Package card row ── */
.package-row {
  display: grid;
  gap: 0;
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 0.5rem;
  overflow: hidden;
  transition: border-color 0.2s;
}

.package-row:hover { border-color: #58a6ff; }

.pkg-meta {
  padding: 0.5rem 0.75rem;
  border-right: 1px solid var(--border);
  min-width: 0;
}

.pkg-meta .commit { font-size: 0.75rem; font-weight: 700; color: #58a6ff; }
.pkg-meta .msg {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
  font-size: 0.75rem;
  margin-top: 0.15rem;
}
.pkg-meta .age { color: var(--muted); font-size: 0.65rem; margin-top: 0.15rem; }

/* ── Step cell ── */
.step-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 0.25rem;
  border-right: 1px solid var(--border);
  cursor: default;
  min-width: 0;
  height: 100%;
}

.step-cell:last-child { border-right: none; }

/* Connector arrow between cells */
.step-cell::before {
  content: '';
  position: absolute;
  left: -1px;
  top: 50%;
  transform: translateY(-50%);
  width: 0;
  height: 0;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-left: 7px solid var(--bg);
  z-index: 1;
  pointer-events: none;
}

.step-cell:first-of-type::before { display: none; }

.step-badge {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.15rem 0.4rem;
  border-radius: 3px;
  border: 1px solid transparent;
}

.step-value {
  font-size: 0.7rem;
  color: var(--muted);
  margin-top: 0.2rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  text-align: center;
}

/* Status colours */
.passed .step-badge  { background: rgba(63,185,80,0.15);  border-color: var(--passed);  color: var(--passed);  }
.failed .step-badge  { background: rgba(248,81,73,0.15);   border-color: var(--failed);  color: var(--failed);  }
.running .step-badge { background: rgba(210,153,34,0.15);  border-color: var(--running); color: var(--running); }
.pending .step-badge { background: rgba(56,139,253,0.12);  border-color: var(--pending); color: var(--pending); }
.skipped    .step-badge { background: transparent; border-color: var(--skipped);    color: var(--skipped);    }
.superseded .step-badge { background: transparent; border-color: var(--superseded); color: var(--superseded); }

/* Active cell highlight */
.step-cell.active-step::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(88,166,255,0.04);
  pointer-events: none;
}

/* Tooltip */
.step-cell[title]:hover::after {
  content: attr(title);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: #1c2128;
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 0.7rem;
  padding: 0.4rem 0.6rem;
  border-radius: 4px;
  white-space: pre;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  z-index: 10;
  pointer-events: none;
}

.empty-state {
  text-align: center;
  color: var(--muted);
  padding: 3rem;
  font-size: 0.85rem;
}

footer {
  margin-top: 2rem;
  color: var(--muted);
  font-size: 0.7rem;
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
  display: flex;
  gap: 1rem;
}

a { color: inherit; text-decoration: none; }
a:hover { text-decoration: underline; }
`;

// ─── Grid template helper ─────────────────────────────────────────────────

function gridTemplate(stepCount: number): string {
  return `grid-template-columns: 200px repeat(${stepCount}, 1fr)`;
}

// ─── Landing page ─────────────────────────────────────────────────────────

export function renderLandingPage(
  summaries: Array<{ pipeline: PipelineConfig; latest: Package | null }>,
  now: Date,
): string {
  const cards = summaries
    .map(({ pipeline, latest }) => {
      const status = latest ? packageOverallStatus(latest) : "pending";
      const lastInfo = latest
        ? `<span class="commit-ref">${latest.commitHash.slice(0, 7)}</span>${escHtml(latest.message?.slice(0, 60) ?? "")} &middot; ${relativeTime(latest.createdAt)}`
        : `<span>No commits tracked yet</span>`;

      return `<a class="pipeline-card" href="/pipeline/${escHtml(pipeline.id)}">
      <div class="status-dot ${status}"></div>
      <div class="pipeline-name">${escHtml(pipeline.name)}</div>
      <div class="pipeline-last">${lastInfo}</div>
    </a>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>App Conveyor</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <h1>App Conveyor</h1>
    <span class="refresh-hint">auto-refresh 30s &middot; ${now.toISOString().slice(11, 19)} UTC</span>
  </header>

  <div class="pipeline-list">
    ${cards}
  </div>

  <footer>
    <span>${summaries.length} pipeline(s) configured</span>
  </footer>
</body>
</html>`;
}

// ─── Pipeline dashboard ───────────────────────────────────────────────────

export function renderDashboard(
  packages: Package[],
  cfg: PipelineConfig,
  now: Date,
): string {
  const steps = cfg.steps.filter((s) => s.type !== "git");
  const grid = gridTemplate(steps.length);

  const headerCols = steps
    .map(
      (s) => `
    <div class="belt-col-label">${stepLabel(s)}</div>
  `,
    )
    .join("");

  const rows =
    packages.length === 0
      ? `<div class="empty-state">No commits tracked yet. Waiting for first commit…</div>`
      : packages
          .map((pkg) => renderPackageRow(pkg, steps, grid, cfg.id))
          .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>${escHtml(cfg.name)} — App Conveyor</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <h1><a href="/">App Conveyor</a> <span style="color:var(--muted);font-weight:400">/</span> ${escHtml(cfg.name)}</h1>
    <span class="refresh-hint">auto-refresh 30s &middot; ${now.toISOString().slice(11, 19)} UTC</span>
    <form method="POST" action="/pipeline/${escHtml(cfg.id)}/sync" style="margin:0">
      <button class="sync-btn" type="submit">Sync now</button>
    </form>
  </header>

  <div class="belt-header" style="${grid}">
    <div></div>
    ${headerCols}
  </div>

  <div class="belt-rows">
    ${rows}
  </div>

  <footer>
    <span>${packages.length} commit(s) tracked</span>
  </footer>
</body>
</html>`;
}

function renderPackageRow(
  pkg: Package,
  steps: StepConfig[],
  grid: string,
  pipelineId: string,
): string {
  const stepMap = new Map(pkg.steps.map((s) => [s.stepId, s]));
  const age = relativeTime(pkg.createdAt);
  const shortCommit = pkg.commitHash.slice(0, 7);
  const msgTrunc = (pkg.message ?? "").slice(0, 48);

  const stepCells = steps
    .map((cfg) => {
      const state = stepMap.get(cfg.id);
      if (!state) {
        return `<div class="step-cell pending" title="not yet initialized">
        <span class="step-badge">Wait</span>
        <span class="step-value">…</span>
      </div>`;
      }

      const cls = STATUS_CLASS[state.status] ?? "pending";
      const badge = STATUS_LABEL[state.status] ?? state.status;
      const tooltip = [
        `${stepLabel(cfg)} [${cfg.id}]`,
        `status: ${state.status}`,
        state.detail ? `\n${state.detail}` : "",
        `\nupdated: ${state.updatedAt.slice(0, 19).replace("T", " ")}`,
      ]
        .filter(Boolean)
        .join(" ");

      const isActive = state.status === "running";

      return `<div class="step-cell ${cls}${isActive ? " active-step" : ""}" title="${escHtml(tooltip)}">
      <span class="step-badge">${badge}</span>
      <span class="step-value">${escHtml(state.label)}</span>
    </div>`;
    })
    .join("");

  return `<a class="package-row" style="${grid}" href="/pipeline/${escHtml(pipelineId)}/package/${shortCommit}">
    <div class="pkg-meta">
      <div class="commit">${shortCommit}</div>
      <div class="msg" title="${escHtml(pkg.message ?? "")}">${escHtml(msgTrunc)}</div>
      <div class="age">${age} &middot; ${escHtml(pkg.branch)}</div>
    </div>
    ${stepCells}
  </a>`;
}

// ─── Package detail ───────────────────────────────────────────────────────

export function renderPackageDetail(
  pkg: Package,
  pipeline: PipelineConfig,
  history: StepHistoryEntry[],
  canReset = false,
): string {
  const detailCSS = `
    ${CSS}
    details.action-menu { position: relative; display: inline-block; }
    details.action-menu summary { list-style: none; cursor: pointer; }
    details.action-menu summary::-webkit-details-marker { display: none; }
    details.action-menu .action-items {
      position: absolute; right: 0; top: calc(100% + 4px);
      background: var(--surface); border: 1px solid var(--border); border-radius: 4px;
      padding: 0.25rem; display: flex; flex-direction: column; gap: 0.25rem;
      z-index: 20; min-width: 13rem;
    }
    details.action-menu .action-items form { margin: 0; }
    details.action-menu .action-items .sync-btn { width: 100%; text-align: left; }
    .step-detail { border: 1px solid var(--border); border-radius: 6px; padding: 1rem; margin-bottom: 1rem; background: var(--surface); }
    .step-detail h3 { font-size: 0.85rem; margin-bottom: 0.4rem; text-transform: uppercase; letter-spacing: 0.06em; }
    .detail-text { color: var(--muted); font-size: 0.75rem; margin-bottom: 0.5rem; white-space: pre-wrap; word-break: break-all; }
    .hist-table { width: 100%; border-collapse: collapse; font-size: 0.72rem; }
    .hist-table th, .hist-table td { padding: 0.3rem 0.5rem; border: 1px solid var(--border); text-align: left; }
    .hist-table th { color: var(--muted); }
    .badge { font-size: 0.6rem; padding: 0.1rem 0.3rem; border-radius: 3px; margin-left: 0.4rem; vertical-align: middle; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge.passed { background: rgba(63,185,80,0.15); color: var(--passed); }
    .badge.failed { background: rgba(248,81,73,0.15); color: var(--failed); }
    .badge.running { background: rgba(210,153,34,0.15); color: var(--running); }
    .badge.pending { background: rgba(56,139,253,0.12); color: var(--pending); }
    a.breadcrumb { color: #58a6ff; }
    a.breadcrumb:hover { text-decoration: underline; }
  `;

  const steps = pipeline.steps.filter((s) => s.type !== "git");
  const rows = steps
    .map((s) => {
      const state = pkg.steps.find((ps) => ps.stepId === s.id);
      const hist = history.filter((h) => h.step_id === s.id);
      const histRows = hist
        .map(
          (h) => `
      <tr>
        <td>${h.recorded_at.slice(0, 19).replace("T", " ")}</td>
        <td class="${STATUS_CLASS[h.status] ?? ""}">${h.status}</td>
        <td>${escHtml(h.label)}</td>
        <td>${escHtml(h.detail ?? "")}</td>
      </tr>
    `,
        )
        .join("");

      const statusCls = state ? (STATUS_CLASS[state.status] ?? "") : "pending";
      const statusTxt = state?.status ?? "pending";
      const link = stepGithubLink(s, state);

      return `
      <section class="step-detail">
        <h3>${escHtml(stepLabel(s))} <span class="badge ${statusCls}">${statusTxt}</span>${link ? ` <a class="breadcrumb" href="${link}" target="_blank" rel="noopener" style="font-size:0.75rem;font-weight:400">↗ GitHub</a>` : ""}</h3>
        <p class="detail-text">${escHtml(state?.detail ?? "")}</p>
        ${
          hist.length > 0
            ? `
        <table class="hist-table">
          <thead><tr><th>Time</th><th>Status</th><th>Label</th><th>Detail</th></tr></thead>
          <tbody>${histRows}</tbody>
        </table>`
            : ""
        }
      </section>
    `;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pkg.commitHash.slice(0, 7)} — ${escHtml(pipeline.name)} — App Conveyor</title>
  <style>${detailCSS}</style>
</head>
<body>
  <header>
    <h1>
      <a class="breadcrumb" href="/">App Conveyor</a>
      <span style="color:var(--muted);font-weight:400"> / </span>
      <a class="breadcrumb" href="/pipeline/${escHtml(pipeline.id)}">${escHtml(pipeline.name)}</a>
      <span style="color:var(--muted);font-weight:400"> / </span>
      <a class="breadcrumb" href="https://github.com/${escHtml(pkg.repoFullName)}/commit/${pkg.commitHash}" target="_blank" rel="noopener">${pkg.commitHash.slice(0, 7)}</a>
    </h1>
    ${
      pkg.status === "active" || canReset
        ? `<div style="display:flex;gap:0.5rem;align-items:center;margin:0">
      ${
        pkg.status === "active"
          ? `<form method="POST" action="/pipeline/${escHtml(pipeline.id)}/package/${escHtml(pkg.commitHash.slice(0, 7))}/sync" style="margin:0">
        <button class="sync-btn" type="submit">Sync now</button>
      </form>`
          : ""
      }
      ${
        canReset
          ? `<details class="action-menu">
        <summary class="sync-btn">Actions ▾</summary>
        <div class="action-items">
          <form method="POST" action="/pipeline/${escHtml(pipeline.id)}/package/${escHtml(pkg.commitHash.slice(0, 7))}/retry">
            <button class="sync-btn warn" type="submit">Retry</button>
          </form>
          <form method="POST" action="/pipeline/${escHtml(pipeline.id)}/package/${escHtml(pkg.commitHash.slice(0, 7))}/reset">
            <button class="sync-btn danger" type="submit">Reset with current config</button>
          </form>
        </div>
      </details>`
          : ""
      }
    </div>`
        : ""
    }
  </header>
  <div style="margin-bottom:1rem">
    <div style="color:var(--text);font-size:0.8rem;margin-bottom:0.25rem">${escHtml(pkg.message ?? "")}</div>
    <div style="color:var(--muted);font-size:0.75rem">
      ${escHtml(pkg.repoFullName)} / ${escHtml(pkg.branch)} &middot; ${escHtml(pkg.authorName ?? "")} &middot; ${relativeTime(pkg.createdAt)}
    </div>
  </div>
  ${rows}
</body>
</html>`;
}

function stepGithubLink(
  cfg: StepConfig,
  state: StepState | undefined,
): string | null {
  if (!state) return null;
  const repo = cfg.repo ?? "";
  switch (cfg.type) {
    case "gha":
      if (state.ghaRunId && repo)
        return `https://github.com/${repo}/actions/runs/${state.ghaRunId}`;
      break;
    case "gh-pr": {
      const prNum = state.label.match(/^#(\d+)$/)?.[1];
      if (prNum && repo) return `https://github.com/${repo}/pull/${prNum}`;
      break;
    }
    case "ghcr": {
      // link to the package version list; image is e.g. "ghcr.io/org/repo"
      const image = cfg.image?.replace(/^ghcr\.io\//, "") ?? "";
      if (image)
        return `https://github.com/${image}/pkgs/container/${image.split("/").at(-1)}`;
      break;
    }
  }
  return null;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
