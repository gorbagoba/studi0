import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';
import type { Question } from '@studi0/shared';

export interface QuestionRow {
  id: string;
  subject_id: string;
  lesson_id: string | null;
  topic: string;
  type: Question['type'];
  payload_json: string;
  key_json: string;
  key_status: Question['keyStatus'];
  source: Question['source'];
  created_at: string;
}

/** Contract shape â€” the answer key is NEVER included. */
export function questionToDto(row: QuestionRow): Question {
  return {
    id: row.id,
    subjectId: row.subject_id,
    lessonId: row.lesson_id,
    topic: row.topic,
    type: row.type,
    payload: JSON.parse(row.payload_json) as Question['payload'],
    keyStatus: row.key_status,
    source: row.source,
    createdAt: row.created_at,
  };
}

export interface NewQuestion {
  subjectId: string;
  lessonId: string | null;
  topic: string;
  type: Question['type'];
  payload: Question['payload'];
  key: unknown;
  source: Question['source'];
}

export function insertQuestion(db: Db, q: NewQuestion): QuestionRow {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO questions (id, subject_id, lesson_id, topic, type, payload_json, key_json, key_status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    q.subjectId,
    q.lessonId,
    q.topic,
    q.type,
    JSON.stringify(q.payload),
    JSON.stringify(q.key),
    'unverified',
    q.source,
    new Date().toISOString(),
  );
  return getQuestion(db, id) as QuestionRow;
}

export function getQuestion(db: Db, id: string): QuestionRow | null {
  return (db.prepare('SELECT * FROM questions WHERE id = ?').get(id) ?? null) as unknown as QuestionRow | null;
}

export function setKeyStatus(db: Db, id: string, status: Question['keyStatus']): void {
  db.prepare('UPDATE questions SET key_status = ? WHERE id = ?').run(status, id);
}

export function listQuestions(
  db: Db,
  subjectId: string,
  filter: { topic?: string; type?: Question['type'] },
): QuestionRow[] {
  const conds = ['subject_id = ?'];
  const args: string[] = [subjectId];
  if (filter.topic) {
    conds.push('topic = ?');
    args.push(filter.topic);
  }
  if (filter.type) {
    conds.push('type = ?');
    args.push(filter.type);
  }
  return db
    .prepare(`SELECT * FROM questions WHERE ${conds.join(' AND ')} ORDER BY created_at DESC`)
    .all(...args) as unknown as QuestionRow[];
}
