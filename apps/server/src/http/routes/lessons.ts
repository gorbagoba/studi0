import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { requireSubject } from '../../subjects/service.js';
import * as lessonsRepo from '../../db/repos/lessons.js';
import * as questionsRepo from '../../db/repos/questions.js';
import * as attemptsRepo from '../../db/repos/attempts.js';
import { safeResolve, isInside } from '../../fs/paths.js';
import { parseLessonMarker, extractTitle } from '../../teacher/lessons.js';
import { HttpError } from '../../util/errors.js';
import { lessonReviewResponseSchema, type LessonReviewResponse } from '@studi0/shared';

export async function registerLessonRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db } = ctx;

  app.get('/api/subjects/:id/lessons', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    return lessonsRepo.listLessons(db, subject.id).map(lessonsRepo.lessonToDto);
  });

  // Lesson review marking: the latest attempt on every bank question of this
  // lesson must be correct (mastery bar). Answers themselves already went
  // through the normal teacher-graded /answer flow.
  app.post('/api/lessons/:id/review', async (req) => {
    const lesson = lessonsRepo.getLesson(db, (req.params as { id: string }).id);
    if (!lesson) throw new HttpError('FILE_NOT_FOUND', `lesson not found`);
    const bank = questionsRepo.listQuestions(db, lesson.subject_id, { lessonId: lesson.id });
    if (bank.length === 0) {
      throw new HttpError('VALIDATION', 'this lesson has no review questions yet');
    }
    const latest = new Map<string, string>();
    for (const a of attemptsRepo.listAttempts(db, lesson.subject_id)) {
      latest.set(a.question_id, JSON.parse(a.grade_json).verdict as string);
    }
    const results = bank.map((q) => {
      const verdict = latest.get(q.id) ?? null;
      return { questionId: q.id, verdict: verdict ?? 'unanswered', answered: verdict !== null };
    });
    const pass = results.length > 0 && results.every((r) => r.verdict === 'correct');
    const reviewedAt = pass ? new Date().toISOString() : null;
    lessonsRepo.setReviewed(db, lesson.id, reviewedAt);
    const res: LessonReviewResponse = {
      verdict: pass ? 'pass' : 'retry',
      results,
      reviewedAt,
    };
    return lessonReviewResponseSchema.parse(res);
  });

  app.get('/api/subjects/:id/lessons/content', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const rel = (req.query as { path?: string }).path;
    if (!rel) throw new HttpError('VALIDATION', 'missing path query parameter');
    const abs = safeResolve(subject.path, rel);
    if (!isInside(path.join(subject.path, 'lessons'), abs)) {
      throw new HttpError('PATH_TRAVERSAL', `not a lesson path: ${rel}`);
    }
    if (!existsSync(abs)) throw new HttpError('FILE_NOT_FOUND', `lesson not found: ${rel}`);
    const html = await readFile(abs, 'utf8');
    const marker = parseLessonMarker(html);
    const s = await stat(abs);
    return {
      path: rel,
      title: extractTitle(html, path.basename(rel, '.html')),
      html,
      nodeTags: marker?.nodes ?? [],
      updatedAt: s.mtime.toISOString(),
    };
  });
}
