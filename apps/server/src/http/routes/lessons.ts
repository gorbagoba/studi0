import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { requireSubject } from '../../subjects/service.js';
import * as lessonsRepo from '../../db/repos/lessons.js';
import { safeResolve, isInside } from '../../fs/paths.js';
import { parseLessonMarker, extractTitle } from '../../teacher/lessons.js';
import { HttpError } from '../../util/errors.js';

export async function registerLessonRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db } = ctx;

  app.get('/api/subjects/:id/lessons', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    return lessonsRepo.listLessons(db, subject.id).map(lessonsRepo.lessonToDto);
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
