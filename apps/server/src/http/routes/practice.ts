import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { parseWith } from '../validate.js';
import {
  generateBodySchema,
  answerBodySchema,
  answerResponseSchema,
  type AnswerResponse,
} from '@studi0/shared';
import { requireSubject } from '../../subjects/service.js';
import * as questionsRepo from '../../db/repos/questions.js';
import * as scheduleRepo from '../../db/repos/schedule.js';
import * as attemptsRepo from '../../db/repos/attempts.js';
import * as lessonsRepo from '../../db/repos/lessons.js';
import { generateQuestions } from '../../practice/generate.js';
import { verifyQuestionKey } from '../../practice/verifyKey.js';
import { verifyKeysAndEmit } from '../../teacher/practiceFeed.js';
import { gradeAnswer } from '../../practice/grade.js';
import { nextSchedule } from '../../practice/scheduler.js';
import { computeStats } from '../../practice/stats.js';
import { HttpError } from '../../util/errors.js';

export async function registerPracticeRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db, cfg } = ctx;

  app.get('/api/subjects/:id/questions', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const q = req.query as { topic?: string; type?: string; lessonId?: string };
    const type =
      q.type === 'mcq' || q.type === 'short' || q.type === 'code' ? q.type : undefined;
    return questionsRepo
      .listQuestions(db, subject.id, { topic: q.topic, type, lessonId: q.lessonId })
      .map(questionsRepo.questionToDto);
  });

  app.post('/api/subjects/:id/questions/generate', async (req, reply) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const body = parseWith(generateBodySchema, req.body);
    if (body.lessonId && !lessonsRepo.getLesson(db, body.lessonId)) {
      throw new HttpError('FILE_NOT_FOUND', `lesson ${body.lessonId} not found`);
    }
    ocGate(ctx);
    const questions = await generateQuestions(ctx.oneshot, db, subject, {
      topic: body.topic,
      count: body.count,
      difficulty: body.difficulty,
      lessonId: body.lessonId ?? null,
      source: 'on_demand',
    });
    // contract: verification runs right after, async; one `questions` SSE event when done
    verifyKeysAndEmit(db, ctx.events, ctx.oneshot, subject, questions);
    return reply.code(201).send(questions);
  });

  app.post('/api/questions/:id/answer', async (req) => {
    const row = requireQuestion(db, (req.params as { id: string }).id);
    const { answer, confidence } = parseWith(answerBodySchema, req.body);
    if (row.type !== 'mcq') ocGate(ctx); // short/code grading needs the LLM
    const grade = await gradeAnswer(ctx.oneshot, subjectPath(db, row.subject_id), row, answer);
    const attempt = attemptsRepo.insertAttempt(db, row.id, row.subject_id, answer, grade, confidence);
    const sched = scheduleRepo.getSchedule(db, row.id);
    const next = nextSchedule(sched?.interval_index ?? 0, grade.verdict === 'correct', cfg, sched?.correct_streak ?? 0);
    const dueAt = new Date(Date.now() + next.intervalDays * 24 * 3600 * 1000).toISOString();
    scheduleRepo.upsertSchedule(db, {
      question_id: row.id,
      subject_id: row.subject_id,
      due_at: dueAt,
      interval_index: next.intervalIndex,
      correct_streak: grade.verdict === 'correct' ? (sched?.correct_streak ?? 0) + 1 : 0,
    });
    const res: AnswerResponse = {
      attemptId: attempt.id,
      grade,
      nextDueAt: dueAt,
      intervalDays: next.intervalDays,
    };
    return parseWith(answerResponseSchema, res);
  });

  app.post('/api/questions/:id/verify-key', async (req) => {
    const row = requireQuestion(db, (req.params as { id: string }).id);
    ocGate(ctx);
    return verifyQuestionKey(ctx.oneshot, db, requireSubject(db, row.subject_id), row);
  });

  app.post('/api/questions/:id/reveal-key', async (req) => {
    const row = requireQuestion(db, (req.params as { id: string }).id);
    // THE gate (AC19): only a verified key is revealed
    if (row.key_status !== 'verified') {
      throw new HttpError('KEY_NOT_VERIFIED', 'key has not passed verification', {
        keyStatus: row.key_status,
      });
    }
    return { key: JSON.parse(row.key_json) };
  });

  app.get('/api/subjects/:id/practice/due', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const now = new Date().toISOString();
    const due = scheduleRepo.dueQuestions(db, subject.id, now);
    return { date: now, questions: due.map((d) => questionsRepo.questionToDto(d.question)) };
  });

  app.get('/api/subjects/:id/practice/stats', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    return computeStats(db, subject.id, new Date().toISOString());
  });
}

function requireQuestion(db: Ctx['db'], id: string) {
  const row = questionsRepo.getQuestion(db, id);
  if (!row) throw new HttpError('QUESTION_NOT_FOUND', 'question not found');
  return row;
}

function ocGate(ctx: Ctx): void {
  ctx.oc.ensureUp();
}

function subjectPath(db: Ctx['db'], subjectId: string): string {
  return requireSubject(db, subjectId).path;
}
