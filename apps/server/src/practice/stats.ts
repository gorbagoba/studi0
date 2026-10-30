import * as attemptsRepo from '../db/repos/attempts.js';
import * as questionsRepo from '../db/repos/questions.js';
import { countDue } from '../db/repos/schedule.js';
import type { Db } from '../db/index.js';
import type { Stats } from '@studi0/shared';

/** All stats computed from attempts/schedule on read — nothing pre-aggregated. */
export function computeStats(db: Db, subjectId: string, nowIso: string): Stats {
  const attempts = attemptsRepo.listAttempts(db, subjectId);
  const byTopic = new Map<string, { attempts: number; correct: number }>();
  for (const a of attempts) {
    const q = questionsRepo.getQuestion(db, a.question_id);
    if (!q) continue;
    const t = byTopic.get(q.topic) ?? { attempts: 0, correct: 0 };
    t.attempts++;
    if ((JSON.parse(a.grade_json) as { verdict: string }).verdict === 'correct') t.correct++;
    byTopic.set(q.topic, t);
  }
  return {
    perTopic: [...byTopic.entries()]
      .map(([topic, t]) => ({
        topic,
        attempts: t.attempts,
        correct: t.correct,
        accuracy: t.attempts ? t.correct / t.attempts : 0,
      }))
      .sort((a, b) => a.topic.localeCompare(b.topic)),
    dueCount: countDue(db, subjectId, nowIso),
    streakDays: computeStreak(attempts.map((a) => a.created_at)),
    totalQuestions: questionsRepo.listQuestions(db, subjectId, {}).length,
  };
}

/** Consecutive days ending today or yesterday with ≥1 attempt. */
export function computeStreak(createdAts: string[]): number {
  const days = new Set(
    createdAts.map((iso) => localDay(new Date(iso))),
  );
  if (days.size === 0) return 0;
  const cursor = new Date();
  const today = localDay(cursor);
  if (!days.has(today)) {
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(localDay(cursor))) return 0;
  }
  let streak = 0;
  while (days.has(localDay(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
