import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runMigrations } from "../migrations";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

test("runMigrations creates schema_migrations table", () => {
  const db = freshDb();
  runMigrations(db);
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get();
  expect(row?.name).toBe("schema_migrations");
});

test("runMigrations is idempotent", () => {
  const db = freshDb();
  runMigrations(db);
  const after1 = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migrations")
    .get()?.n;
  runMigrations(db); // second call must not throw or add rows
  const after2 = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migrations")
    .get()?.n;
  expect(after2).toBe(after1);
});

test("runMigrations records each applied migration exactly once", () => {
  const db = freshDb();
  runMigrations(db);
  runMigrations(db);
  const rows = db
    .query<{ version: number }, []>(
      "SELECT version FROM schema_migrations ORDER BY version",
    )
    .all();
  const versions = rows.map((r) => r.version);
  expect(versions).toEqual([...new Set(versions)]);
});
