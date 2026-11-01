import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../src/db/index.js';

function tempDb(): Db {
  return openDb(path.join(mkdtempSync(path.join(tmpdir(), 'studi0-mig-')), 'studi0.db'));
}

function tableNames(db: Db): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as unknown as { name: string }[];
  return rows.map((r) => r.name).sort();
}

function indexNames(db: Db): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
    .all() as unknown as { name: string }[];
  return rows.map((r) => r.name).sort();
}

describe('migrations', () => {
  it('creates every metadata table and index', () => {
    const db = tempDb();
    expect(tableNames(db)).toEqual([
      'attempts',
      'chat_sessions',
      'files',
      'groups',
      'jobs',
      'lessons',
      'questions',
      'schedule',
      'subjects',
    ]);
    expect(indexNames(db)).toEqual([
      'idx_attempts_q',
      'idx_jobs_sub',
      'idx_questions_s',
      'idx_sched_due',
      'idx_subjects_group',
    ]);
    expect(
      (db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }).user_version,
    ).toBe(2);
  });

  it('is idempotent — reopening a migrated db changes nothing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'studi0-mig-'));
    const dbPath = path.join(dir, 'studi0.db');
    openDb(dbPath);
    const before = tableNames(openDb(dbPath));
    expect(openDb(dbPath).prepare('SELECT COUNT(*) AS n FROM subjects').get()).toEqual({ n: 0 });
    expect(tableNames(openDb(dbPath))).toEqual(before);
  });

  it('accepts inserts matching the schema (foreign keys on)', () => {
    const db = tempDb();
    db.prepare(
      'INSERT INTO subjects (id, name, path, created_at) VALUES (?, ?, ?, ?)',
    ).run('s1', 'CS2040C', 'C:/course', '2026-01-01T00:00:00.000Z');
    db.prepare(
      'INSERT INTO jobs (id, subject_id, kind, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('j1', 's1', 'build', 'queued', '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(
      'g1',
      'MATH',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare('UPDATE subjects SET group_id = ? WHERE id = ?').run('g1', 's1');
    // invalid foreign keys rejected (subject→group included)
    expect(() =>
      db
        .prepare(
          'INSERT INTO jobs (id, subject_id, kind, status, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('j2', 'missing', 'build', 'queued', '2026-01-01T00:00:00.000Z'),
    ).toThrow();
    expect(() =>
      db.prepare('UPDATE subjects SET group_id = ? WHERE id = ?').run('missing', 's1'),
    ).toThrow();
  });
});
