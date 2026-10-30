import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';
import type { Lesson } from '@studi0/shared';

export interface LessonRow {
  id: string;
  subject_id: string;
  rel_path: string;
  title: string;
  node_tags_json: string;
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
  };
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

/** Ordered by filename prefix â€” the agent numbers lessons along the syllabus spine. */
export function listLessons(db: Db, subjectId: string): LessonRow[] {
  return db
    .prepare('SELECT * FROM lessons WHERE subject_id = ? ORDER BY rel_path')
    .all(subjectId) as unknown as LessonRow[];
}
