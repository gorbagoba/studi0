import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';
import type { ChatSession } from '@studi0/shared';

export interface ChatSessionRow {
  id: string;
  subject_id: string;
  lesson_id: string | null;
  oc_session_id: string;
  active: number;
  msg_count: number;
  summary_path: string | null;
  created_at: string;
  rotated_at: string | null;
  title: string | null;
}

export function sessionToDto(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    subjectId: row.subject_id,
    lessonId: row.lesson_id,
    active: row.active === 1,
    messageCount: row.msg_count,
    summaryPath: row.summary_path,
    createdAt: row.created_at,
    lastMessageAt: row.rotated_at,
    title: row.title,
  };
}

export function insertSession(
  db: Db,
  subjectId: string,
  ocSessionId: string,
  lessonId: string | null,
): ChatSessionRow {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO chat_sessions (id, subject_id, lesson_id, oc_session_id, active, msg_count, created_at) VALUES (?, ?, ?, ?, 1, 0, ?)',
  ).run(id, subjectId, lessonId, ocSessionId, new Date().toISOString());
  return getSession(db, id) as ChatSessionRow;
}

export function getSession(db: Db, id: string): ChatSessionRow | null {
  return (db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) ?? null) as unknown as ChatSessionRow | null;
}

export function listSessions(db: Db, subjectId: string): ChatSessionRow[] {
  return db
    .prepare('SELECT * FROM chat_sessions WHERE subject_id = ? ORDER BY created_at DESC')
    .all(subjectId) as unknown as ChatSessionRow[];
}

export function sessionAfterTurn(db: Db, id: string): void {
  db.prepare(
    'UPDATE chat_sessions SET msg_count = msg_count + 2, rotated_at = ? WHERE id = ?',
  ).run(new Date().toISOString(), id);
}

export function renameSession(db: Db, id: string, title: string): void {
  db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(title, id);
}

export function rotateSession(db: Db, id: string, summaryPath: string): void {
  db.prepare(
    'UPDATE chat_sessions SET active = 0, summary_path = ?, rotated_at = ? WHERE id = ?',
  ).run(summaryPath, new Date().toISOString(), id);
}
