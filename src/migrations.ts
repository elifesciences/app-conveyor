import type { Database } from "bun:sqlite";

interface Migration {
  version: number;
  up: (db: Database) => void;
}

/**
 * All schema migrations in order. Each migration runs exactly once, identified
 * by its version number. Add new migrations to the end of this array — never
 * edit or reorder existing entries.
 *
 * Migration 1 uses CREATE TABLE IF NOT EXISTS so it is safe to run against
 * databases that existed before the migration system was introduced.
 */
const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
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
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          package_id    TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
          step_id       TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'pending',
          label         TEXT NOT NULL DEFAULT '',
          detail        TEXT,
          updated_at    TEXT NOT NULL,
          commit_hash   TEXT,
          gha_run_id    TEXT,
          image_digest  TEXT,
          image_tag     TEXT,
          sync_revision TEXT,
          UNIQUE(package_id, step_id)
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS step_history (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          package_id  TEXT NOT NULL,
          step_id     TEXT NOT NULL,
          status      TEXT NOT NULL,
          label       TEXT NOT NULL DEFAULT '',
          detail      TEXT,
          recorded_at TEXT NOT NULL
        )
      `);
    },
  },
  {
    version: 2,
    up: (db) => db.run("ALTER TABLE packages ADD COLUMN config_snapshot TEXT"),
  },
  {
    version: 3,
    up: (db) =>
      db.run(
        "ALTER TABLE packages ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
      ),
  },
  {
    // Fix inconsistent state: superseded packages must not have pending/running
    // steps. This can occur if a reset happened just before the package was
    // superseded, leaving downstream steps stuck in 'pending' permanently.
    version: 4,
    up: (db) => {
      const stale = db
        .query<{ package_id: string; step_id: string }, []>(
          `SELECT ss.package_id, ss.step_id
           FROM step_states ss
           JOIN packages p ON p.id = ss.package_id
           WHERE p.status = 'superseded'
             AND ss.status IN ('pending', 'running')`,
        )
        .all();
      const ts = new Date().toISOString();
      const detail = "superseded by newer deployment";
      for (const { package_id, step_id } of stale) {
        db.run(
          "UPDATE step_states SET status = 'skipped', label = '–', detail = ?, updated_at = ? WHERE package_id = ? AND step_id = ?",
          [detail, ts, package_id, step_id],
        );
        db.run(
          "INSERT INTO step_history (package_id, step_id, status, label, detail, recorded_at) VALUES (?, ?, 'skipped', '–', ?, ?)",
          [package_id, step_id, detail, ts],
        );
      }
    },
  },
];

export function runMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db
      .query<{ version: number }, []>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version),
  );

  let count = 0;
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    migration.up(db);
    db.run(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      [migration.version, new Date().toISOString()],
    );
    console.log(`[migrations] applied migration ${migration.version}`);
    count++;
  }
  if (count === 0) {
    console.log(`[migrations] schema up to date (${applied.size} applied)`);
  }
}
