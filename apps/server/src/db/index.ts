import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type Db = DatabaseSync;

const migrationsDir = path.join(import.meta.dirname, 'migrations');

function listMigrations(): { version: number; sql: string }[] {
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({
      version: Number.parseInt(f.split('_')[0] ?? '', 10),
      sql: readFileSync(path.join(migrationsDir, f), 'utf8'),
    }))
    .filter((m) => Number.isFinite(m.version));
  // two files sharing a prefix silently shadow each other (version <= current skips the second) — fail fast instead
  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`duplicate migration version ${m.version} in ${migrationsDir} — rename one file`);
    }
    seen.add(m.version);
  }
  return migrations;
}

/** Open the metadata DB, apply pending migrations (PRAGMA user_version). */
export function openDb(dbPath: string): Db {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  for (const m of listMigrations()) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.version} failed: ${String(e)}`);
    }
  }
  return db;
}
