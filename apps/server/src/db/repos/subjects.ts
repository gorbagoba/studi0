import type { Db } from '../index.js';

export interface SubjectRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
  last_built_at: string | null;
  group_id: string | null;
  group_name?: string | null; // joined from groups (SELECT s.*, g.name AS group_name)
}

export function insertSubject(
  db: Db,
  s: Omit<SubjectRow, 'last_built_at' | 'group_id' | 'group_name'>,
): SubjectRow {
  db.prepare(
    'INSERT INTO subjects (id, name, path, created_at, last_built_at, group_id) VALUES (?, ?, ?, ?, NULL, NULL)',
  ).run(s.id, s.name, s.path, s.created_at);
  return { ...s, group_id: null, group_name: null, last_built_at: null };
}

const SUBJECT_SELECT =
  'SELECT s.*, g.name AS group_name FROM subjects s LEFT JOIN groups g ON g.id = s.group_id';

export function getSubject(db: Db, id: string): SubjectRow | null {
  return (db.prepare(`${SUBJECT_SELECT} WHERE s.id = ?`).get(id) ?? null) as unknown as SubjectRow | null;
}

export function getSubjectByName(db: Db, name: string): SubjectRow | null {
  return (
    (db.prepare(`${SUBJECT_SELECT} WHERE s.name = ?`).get(name) ??
      null) as unknown as SubjectRow | null
  );
}

export function getSubjectByPath(db: Db, subjectPath: string): SubjectRow | null {
  return (
    (db.prepare(`${SUBJECT_SELECT} WHERE s.path = ?`).get(subjectPath) ??
      null) as unknown as SubjectRow | null
  );
}

export function listSubjects(db: Db): SubjectRow[] {
  return db.prepare(`${SUBJECT_SELECT} ORDER BY s.created_at`).all() as unknown as SubjectRow[];
}

export function renameSubject(db: Db, id: string, name: string): void {
  db.prepare('UPDATE subjects SET name = ? WHERE id = ?').run(name, id);
}

export function setSubjectGroup(db: Db, id: string, groupId: string | null): void {
  db.prepare('UPDATE subjects SET group_id = ? WHERE id = ?').run(groupId, id);
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
