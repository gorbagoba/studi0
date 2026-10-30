import type { Db } from '../index.js';

export interface SubjectRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
  last_built_at: string | null;
}

export function insertSubject(db: Db, s: Omit<SubjectRow, 'last_built_at'>): SubjectRow {
  db.prepare(
    'INSERT INTO subjects (id, name, path, created_at, last_built_at) VALUES (?, ?, ?, ?, NULL)',
  ).run(s.id, s.name, s.path, s.created_at);
  return { ...s, last_built_at: null };
}

export function getSubject(db: Db, id: string): SubjectRow | null {
  return (db.prepare('SELECT * FROM subjects WHERE id = ?').get(id) ?? null) as unknown as SubjectRow | null;
}

export function getSubjectByName(db: Db, name: string): SubjectRow | null {
  return (
    (db.prepare('SELECT * FROM subjects WHERE name = ?').get(name) ?? null) as unknown as SubjectRow | null
  );
}

export function getSubjectByPath(db: Db, subjectPath: string): SubjectRow | null {
  return (
    (db.prepare('SELECT * FROM subjects WHERE path = ?').get(subjectPath) ?? null) as unknown as SubjectRow | null
  );
}

export function listSubjects(db: Db): SubjectRow[] {
  return db.prepare('SELECT * FROM subjects ORDER BY created_at').all() as unknown as SubjectRow[];
}

export function renameSubject(db: Db, id: string, name: string): void {
  db.prepare('UPDATE subjects SET name = ? WHERE id = ?').run(name, id);
}

export function setLastBuilt(db: Db, id: string, ts: string): void {
  db.prepare('UPDATE subjects SET last_built_at = ? WHERE id = ?').run(ts, id);
}

export function deleteSubject(db: Db, id: string): void {
  // unregister only — metadata rows go, disk is never touched
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM schedule WHERE subject_id = ?').run(id);
    db.prepare(
      'DELETE FROM attempts WHERE subject_id = ?',
    ).run(id);
    db.prepare('DELETE FROM questions WHERE subject_id = ?').run(id);
    db.prepare('DELETE FROM chat_sessions WHERE subject_id = ?').run(id);
    db.prepare('DELETE FROM lessons WHERE subject_id = ?').run(id);
    db.prepare('DELETE FROM jobs WHERE subject_id = ?').run(id);
    db.prepare('DELETE FROM files WHERE subject_id = ?').run(id);
    db.prepare('DELETE FROM subjects WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
