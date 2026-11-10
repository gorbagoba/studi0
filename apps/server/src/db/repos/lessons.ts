import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';
import type { Lesson } from '@studi0/shared';

export interface LessonRow {
  id: string;
  subject_id: string;
  rel_path: string;
  title: string;
  node_tags_json: string;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export function lessonToDto(row: LessonRow): Lesson {
  return {
    id: row.id,
    subjectId: row.subject_id,
    path: row.rel_path,
    title: row.title,
    nodeTags: JSON.parse(row.node_tags_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at ?? null,
  };
}

export function updateLessonTitle(db: Db, id: string, title: string): LessonRow | null {
  db.prepare('UPDATE lessons SET title = ?, updated_at = ? WHERE id = ?').run(
    title,
    new Date().toISOString(),
    id,
  );
  return getLesson(db, id);
}

/** Mark a lesson as review-passed (tick in the UI); null clears it. */
export function setReviewed(db: Db, lessonId: string, reviewedAt: string | null): void {
  db.prepare('UPDATE lessons SET reviewed_at = ? WHERE id = ?').run(reviewedAt, lessonId);
}

export function upsertLesson(
  db: Db,
  subjectId: string,
  relPath: string,
  title: string,
  nodeTags: string[],
): LessonRow {
  const now = new Date().toISOString();
  const tags = JSON.stringify(nodeTags);
  const existing = db
    .prepare('SELECT * FROM lessons WHERE subject_id = ? AND rel_path = ?')
    .get(subjectId, relPath) as unknown as LessonRow | undefined;
  if (existing) {
    db.prepare(
      'UPDATE lessons SET title = ?, node_tags_json = ?, updated_at = ? WHERE id = ?',
    ).run(title, tags, now, existing.id);
    return { ...existing, title, node_tags_json: tags, updated_at: now };
  }
  const id = randomUUID();
  db.prepare(
    'INSERT INTO lessons (id, subject_id, rel_path, title, node_tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, subjectId, relPath, title, tags, now, now);
  return getLesson(db, id) as LessonRow;
}

export function getLesson(db: Db, id: string): LessonRow | null {
  return (db.prepare('SELECT * FROM lessons WHERE id = ?').get(id) ?? null) as unknown as LessonRow | null;
}

/** Delete a lesson with its questions and their attempts/schedule rows; returns the row (for its file path). */
export function deleteLesson(db: Db, id: string): LessonRow | null {
  // attempts/schedule have no ON DELETE CASCADE and FKs are on, so they must go first
  db.exec('BEGIN');
  try {
    const row = getLesson(db, id);
    if (!row) {
      db.exec('COMMIT');
      return null;
    }
    // chat sessions outlive their lesson; the FK would otherwise block the delete
    db.prepare('UPDATE chat_sessions SET lesson_id = NULL WHERE lesson_id = ?').run(id);
    db.prepare(
      'DELETE FROM attempts WHERE question_id IN (SELECT id FROM questions WHERE lesson_id = ?)',
    ).run(id);
    db.prepare(
      'DELETE FROM schedule WHERE question_id IN (SELECT id FROM questions WHERE lesson_id = ?)',
    ).run(id);
    db.prepare('DELETE FROM questions WHERE lesson_id = ?').run(id);
    db.prepare('DELETE FROM lessons WHERE id = ?').run(id);
    db.exec('COMMIT');
    return row;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Ordered by filename prefix â€” the agent numbers lessons along the syllabus spine. */
export function listLessons(db: Db, subjectId: string): LessonRow[] {
  return db
    .prepare('SELECT * FROM lessons WHERE subject_id = ? ORDER BY rel_path')
    .all(subjectId) as unknown as LessonRow[];
}
