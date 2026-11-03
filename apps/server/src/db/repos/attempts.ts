import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';
import type { Grade } from '@studi0/shared';

export interface AttemptRow {
  id: string;
  question_id: string;
  subject_id: string;
  answer: string;
  grade_json: string;
  confidence: string | null;
  created_at: string;
}

export function insertAttempt(
  db: Db,
  questionId: string,
  subjectId: string,
  answer: string,
  grade: Grade,
  confidence?: 'high' | 'medium' | 'low',
): AttemptRow {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO attempts (id, question_id, subject_id, answer, grade_json, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, questionId, subjectId, answer, JSON.stringify(grade), confidence ?? null, new Date().toISOString());
  return db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as unknown as AttemptRow;
}

export function listAttempts(db: Db, subjectId: string): AttemptRow[] {
  return db
    .prepare(
      'SELECT a.* FROM attempts a JOIN questions q ON q.id = a.question_id WHERE q.subject_id = ? ORDER BY a.created_at',
    )
    .all(subjectId) as unknown as AttemptRow[];
}
