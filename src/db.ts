import { Database } from "bun:sqlite";
import type { Package, StepHistoryEntry, StepState } from "./types";

interface PackageRow {
  id: string;
  pipeline_id: string;
  commit_hash: string;
  repo: string;
  branch: string;
  author_name: string | null;
  message: string | null;
  created_at: string;
  updated_at: string;
  current_step: number;
}

interface StepStateRow {
  id: number;
  package_id: string;
  step_id: string;
  status: string;
  label: string;
  detail: string | null;
  updated_at: string;
  commit_hash: string | null;
  gha_run_id: string | null;
  image_digest: string | null;
  image_tag: string | null;
  sync_revision: string | null;
}

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  _db = new Database(process.env.DB_PATH ?? "conveyor.db", { create: true });
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA foreign_keys = ON");
  initSchema(_db);
  return _db;
}

function initSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS packages (
      id           TEXT PRIMARY KEY,
      pipeline_id  TEXT NOT NULL,
      commit_hash  TEXT NOT NULL,
      repo         TEXT NOT NULL,
      branch       TEXT NOT NULL,
      author_name  TEXT,
      message      TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      current_step INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS step_states (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id   TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      step_id      TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      label        TEXT NOT NULL DEFAULT '',
      detail       TEXT,
      updated_at   TEXT NOT NULL,
      commit_hash  TEXT,
      gha_run_id   TEXT,
      image_digest TEXT,
      image_tag    TEXT,
      sync_revision TEXT,
      UNIQUE(package_id, step_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS step_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id   TEXT NOT NULL,
      step_id      TEXT NOT NULL,
      status       TEXT NOT NULL,
      label        TEXT NOT NULL DEFAULT '',
      detail       TEXT,
      recorded_at  TEXT NOT NULL
    )
  `);
}

// ─── Package CRUD ─────────────────────────────────────────────────────────────

export function upsertPackage(pkg: Omit<Package, "steps">): void {
  const db = getDb();
  db.run(
    `
    INSERT INTO packages (id, pipeline_id, commit_hash, repo, branch, author_name, message, created_at, updated_at, current_step)
    VALUES ($id, $pipeline_id, $commit_hash, $repo, $branch, $author_name, $message, $created_at, $updated_at, $current_step)
    ON CONFLICT(id) DO UPDATE SET
      updated_at   = excluded.updated_at,
      current_step = excluded.current_step,
      author_name  = excluded.author_name,
      message      = excluded.message
  `,
    {
      $id: pkg.id,
      $pipeline_id: pkg.pipelineId,
      $commit_hash: pkg.commitHash,
      $repo: pkg.repoFullName,
      $branch: pkg.branch,
      $author_name: pkg.authorName ?? null,
      $message: pkg.message ?? null,
      $created_at: pkg.createdAt,
      $updated_at: pkg.updatedAt,
      $current_step: pkg.currentStep,
      // biome-ignore lint/suspicious/noExplicitAny: Bun SQLite named params not in type definitions
    } as any,
  );
}

export function upsertStepState(packageId: string, state: StepState): void {
  const db = getDb();
  const prev = db
    .query<{ status: string; label: string }, [string, string]>(
      "SELECT status, label FROM step_states WHERE package_id = ? AND step_id = ?",
    )
    .get(packageId, state.stepId);

  db.run(
    `
    INSERT INTO step_states
      (package_id, step_id, status, label, detail, updated_at,
       commit_hash, gha_run_id, image_digest, image_tag, sync_revision)
    VALUES
      ($pkg, $step, $status, $label, $detail, $updated_at,
       $commit_hash, $gha_run_id, $image_digest, $image_tag, $sync_revision)
    ON CONFLICT(package_id, step_id) DO UPDATE SET
      status        = excluded.status,
      label         = excluded.label,
      detail        = excluded.detail,
      updated_at    = excluded.updated_at,
      commit_hash   = excluded.commit_hash,
      gha_run_id    = excluded.gha_run_id,
      image_digest  = excluded.image_digest,
      image_tag     = excluded.image_tag,
      sync_revision = excluded.sync_revision
  `,
    {
      $pkg: packageId,
      $step: state.stepId,
      $status: state.status,
      $label: state.label,
      $detail: state.detail ?? null,
      $updated_at: state.updatedAt,
      $commit_hash: state.commitHash ?? null,
      $gha_run_id: state.ghaRunId ?? null,
      $image_digest: state.imageDigest ?? null,
      $image_tag: state.imageTag ?? null,
      $sync_revision: state.syncRevision ?? null,
      // biome-ignore lint/suspicious/noExplicitAny: Bun SQLite named params not in type definitions
    } as any,
  );

  if (!prev || prev.status !== state.status) {
    db.run(
      `
      INSERT INTO step_history (package_id, step_id, status, label, detail, recorded_at)
      VALUES ($pkg, $step, $status, $label, $detail, $recorded_at)
    `,
      {
        $pkg: packageId,
        $step: state.stepId,
        $status: state.status,
        $label: state.label,
        $detail: state.detail ?? null,
        $recorded_at: state.updatedAt,
        // biome-ignore lint/suspicious/noExplicitAny: Bun SQLite named params not in type definitions
      } as any,
    );
  }
}

export function getPackage(id: string): Package | null {
  const db = getDb();
  const row = db
    .query<PackageRow, [string]>("SELECT * FROM packages WHERE id = ?")
    .get(id);
  if (!row) return null;
  return hydrate(db, row);
}

export function findPackageByCommitPrefix(
  pipelineId: string,
  prefix: string,
): Package | null {
  const db = getDb();
  const rows = db
    .query<PackageRow, [string]>(
      "SELECT * FROM packages WHERE pipeline_id = ? ORDER BY created_at DESC LIMIT 200",
    )
    .all(pipelineId);
  const row = rows.find((r) => r.commit_hash.startsWith(prefix));
  return row ? hydrate(db, row) : null;
}

export function listPackages(pipelineId: string, limit = 50): Package[] {
  const db = getDb();
  const rows = db
    .query<PackageRow, [string, number]>(
      "SELECT * FROM packages WHERE pipeline_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(pipelineId, limit);
  return rows.map((r) => hydrate(db, r));
}

function hydrate(db: Database, row: PackageRow): Package {
  const steps = db
    .query<StepStateRow, [string]>(
      "SELECT * FROM step_states WHERE package_id = ? ORDER BY id ASC",
    )
    .all(row.id)
    .map(rowToStep);

  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    commitHash: row.commit_hash,
    repoFullName: row.repo,
    branch: row.branch,
    authorName: row.author_name ?? undefined,
    message: row.message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    currentStep: row.current_step,
    steps,
  };
}

function rowToStep(r: StepStateRow): StepState {
  return {
    stepId: r.step_id,
    status: r.status as StepState["status"],
    label: r.label,
    detail: r.detail ?? undefined,
    updatedAt: r.updated_at,
    commitHash: r.commit_hash ?? undefined,
    ghaRunId: r.gha_run_id ?? undefined,
    imageDigest: r.image_digest ?? undefined,
    imageTag: r.image_tag ?? undefined,
    syncRevision: r.sync_revision ?? undefined,
  };
}

export function getStepHistory(
  packageId: string,
  stepId: string,
): StepHistoryEntry[] {
  const db = getDb();
  return db
    .query<StepHistoryEntry, [string, string]>(
      "SELECT * FROM step_history WHERE package_id = ? AND step_id = ? ORDER BY id DESC LIMIT 20",
    )
    .all(packageId, stepId);
}
