import type { Db } from '../index.js';
import type { QuestionRow } from './questions.js';

export interface ScheduleRow {
  question_id: string;
  subject_id: string;
  due_at: string;
  interval_index: number;
  correct_streak: number;
}

export function upsertSchedule(
  db: Db,
  s: Omit<ScheduleRow, 'correct_streak'> & { correct_streak?: number },
): void {
  db.prepare(
    `INSERT INTO schedule (question_id, subject_id, due_at, interval_index, correct_streak)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(question_id) DO UPDATE SET due_at = excluded.due_at, interval_index = excluded.interval_index, correct_streak = excluded.correct_streak`,
  ).run(s.question_id, s.subject_id, s.due_at, s.interval_index, s.correct_streak ?? 0);
}

export function getSchedule(db: Db, questionId: string): ScheduleRow | null {
  return (
    (db.prepare('SELECT * FROM schedule WHERE question_id = ?').get(questionId) ?? null) as unknown as ScheduleRow | null
  );
}

export function dueQuestions(
  db: Db,
  subjectId: string,
  nowIso: string,
): (ScheduleRow & { question: QuestionRow })[] {
  const rows = db
    .prepare(
      `SELECT q.*, s.due_at AS sched_due_at, s.interval_index AS sched_index, s.correct_streak AS sched_streak
       FROM questions q JOIN schedule s ON s.question_id = q.id
       WHERE s.subject_id = ? AND s.due_at <= ? ORDER BY s.due_at`,
    )
    .all(subjectId, nowIso) as unknown as (QuestionRow & {
    sched_due_at: string;
    sched_index: number;
    sched_streak: number;
  })[];
  return rows.map((r) => ({
    question_id: r.id,
    subject_id: r.subject_id,
    due_at: r.sched_due_at,
    interval_index: r.sched_index,
    correct_streak: r.sched_streak,
    question: r,
  }));
}

export function countDue(db: Db, subjectId: string, nowIso: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM schedule WHERE subject_id = ? AND due_at <= ?')
      .get(subjectId, nowIso) as { n: number }
  ).n;
}
