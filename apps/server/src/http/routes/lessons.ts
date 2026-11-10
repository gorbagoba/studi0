import path from 'node:path';
import { readFile, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { requireSubject } from '../../subjects/service.js';
import * as lessonsRepo from '../../db/repos/lessons.js';
import * as questionsRepo from '../../db/repos/questions.js';
import * as attemptsRepo from '../../db/repos/attempts.js';
import { safeResolve, isInside } from '../../fs/paths.js';
import { safeWriteFile } from '../../fs/safeWrite.js';
import { parseLessonMarker, extractTitle, rewriteLessonTitle } from '../../teacher/lessons.js';
import { parseWith } from '../validate.js';
import { gradeAnswer } from '../../practice/grade.js';
import { HttpError } from '../../util/errors.js';
import {
  lessonReviewSubmitSchema,
  lessonReviewResponseSchema,
  type LessonReviewResponse,
} from '@studi0/shared';

// local on purpose: a lesson rename is route-only, not shared API surface
const renameLessonBodySchema = z.object({
  title: z
    .string()
    .trim()
    .transform((s) => s.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim())
    .pipe(z.string().min(1).max(200)),
});

export async function registerLessonRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db } = ctx;

  app.get('/api/subjects/:id/lessons', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    return lessonsRepo.listLessons(db, subject.id).map(lessonsRepo.lessonToDto);
  });

  // DB is the source of truth: a missing/locked file must not fail the delete.
  app.delete('/api/lessons/:id', async (req) => {
    const lesson = lessonsRepo.deleteLesson(db, (req.params as { id: string }).id);
    if (!lesson) throw new HttpError('FILE_NOT_FOUND', 'lesson not found');
    try {
      const subjectPath = requireSubject(db, lesson.subject_id).path;
      const abs = safeResolve(subjectPath, lesson.rel_path);
      if (!isInside(subjectPath, abs)) {
        throw new HttpError('PATH_TRAVERSAL', `path escapes the subject: ${lesson.rel_path}`);
      }
      await unlink(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        req.log.warn({ err: e }, 'lesson deleted but its file could not be removed');
      }
    }
    return { ok: true };
  });

  // DB is the source of truth; the file is retitled too so a boot re-index agrees.
  app.patch('/api/lessons/:id', async (req) => {
    const lesson = lessonsRepo.getLesson(db, (req.params as { id: string }).id);
    if (!lesson) throw new HttpError('FILE_NOT_FOUND', 'lesson not found');
    const body = parseWith(renameLessonBodySchema, req.body);
    const updated = lessonsRepo.updateLessonTitle(db, lesson.id, body.title);
    if (!updated) throw new HttpError('FILE_NOT_FOUND', 'lesson not found');
    try {
      const subjectPath = requireSubject(db, lesson.subject_id).path;
      const abs = safeResolve(subjectPath, lesson.rel_path);
      await safeWriteFile(abs, rewriteLessonTitle(await readFile(abs, 'utf8'), body.title));
    } catch (e) {
      req.log.warn({ err: e }, 'lesson renamed but its file could not be updated');
    }
    return lessonsRepo.lessonToDto(updated);
  });

  // One-shot lesson review: every submitted answer is graded now (mcq offline,
  // short/code via the LLM) and stored as an attempt; the lesson passes only
  // when every bank question graded correct. Review attempts deliberately skip
  // the practice scheduler (review ≠ drills).
  app.post('/api/lessons/:id/review', async (req) => {
    const lesson = lessonsRepo.getLesson(db, (req.params as { id: string }).id);
    if (!lesson) throw new HttpError('FILE_NOT_FOUND', `lesson not found`);
    const body = parseWith(lessonReviewSubmitSchema, req.body);
    const bank = questionsRepo.listQuestions(db, lesson.subject_id, { lessonId: lesson.id });
    if (bank.length === 0) {
      throw new HttpError('VALIDATION', 'this lesson has no review questions yet');
    }
    const submitted = new Map(body.answers.map((a) => [a.questionId, a]));
    if (bank.some((q) => submitted.has(q.id) && q.type !== 'mcq')) ctx.oc.ensureUp();
    const subjectPath = requireSubject(db, lesson.subject_id).path;
    const results: LessonReviewResponse['results'] = [];
    for (const q of bank) {
      const a = submitted.get(q.id);
      if (!a) {
        results.push({ questionId: q.id, verdict: 'unanswered', answered: false });
        continue;
      }
      const grade = await gradeAnswer(ctx.oneshot, subjectPath, q, a.answer);
      attemptsRepo.insertAttempt(db, q.id, q.subject_id, a.answer, grade, a.confidence);
      results.push({
        questionId: q.id,
        verdict: grade.verdict,
        answered: true,
        feedback: grade.feedback,
      });
    }
    const pass = results.every((r) => r.verdict === 'correct');
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
