import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { parseWith } from '../validate.js';
import {
  courseSetupBodySchema,
  createSubjectBodySchema,
  deleteFilesBodySchema,
  mergeBodySchema,
  renameSubjectBodySchema,
} from '@studi0/shared';
import { applySetupToMission, setupCompleted } from '../../subjects/mission.js';
import { NAME_RE } from '../../subjects/service.js';
import * as subjectsRepo from '../../db/repos/subjects.js';
import * as groupsRepo from '../../db/repos/groups.js';
import {
  requireSubject,
  registerSubject,
  subjectDetail,
  subjectToDto,
  computeStale,
  listSubjectDtos,
} from '../../subjects/service.js';
import { mergeSubject, deleteSubjectFiles } from '../../subjects/files.js';
import { HttpError } from '../../util/errors.js';

export async function registerSubjectRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db } = ctx;

  app.get('/api/subjects', async () => listSubjectDtos(db));

  app.post('/api/subjects/:id/setup', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const body = parseWith(courseSetupBodySchema, req.body ?? {});
    await applySetupToMission(subject.path, body);
    return { ok: true };
  });

  app.get('/api/subjects/:id/setup-status', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    return { done: await setupCompleted(subject.path) };
  });

  app.post('/api/subjects', async (req, reply) => {
    const body = parseWith(createSubjectBodySchema, req.body);
    const row = await registerSubject(ctx.cfg, db, body);
    return reply.code(201).send(await subjectDetail(db, row));
  });

  app.get('/api/subjects/:id', async (req) => {
    return subjectDetail(db, requireSubject(db, (req.params as { id: string }).id));
  });

  app.patch('/api/subjects/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const body = parseWith(renameSubjectBodySchema, req.body);
    const row = requireSubject(db, id);
    if (body.name !== undefined && !NAME_RE.test(body.name)) {
      throw new HttpError('VALIDATION', `invalid subject name: ${body.name}`);
    }
    if (body.groupId !== undefined && body.groupId !== null && !groupsRepo.getGroup(db, body.groupId)) {
      throw new HttpError('GROUP_NOT_FOUND', `group ${body.groupId} not found`);
    }
    if (body.name !== undefined && body.name !== row.name && subjectsRepo.getSubjectByName(db, body.name)) {
      throw new HttpError('NAME_TAKEN', `a subject named "${body.name}" already exists`);
    }
    if (body.name !== undefined) subjectsRepo.renameSubject(db, id, body.name);
    if (body.groupId !== undefined) subjectsRepo.setSubjectGroup(db, id, body.groupId);
    if (body.icon !== undefined) subjectsRepo.setSubjectIcon(db, id, body.icon);
    const fresh = subjectsRepo.getSubject(db, id) as subjectsRepo.SubjectRow;
    return subjectToDto(fresh, await computeStale(row));
  });

  app.post('/api/subjects/:id/merge-into', async (req) => {
    const source = requireSubject(db, (req.params as { id: string }).id);
    const { targetId } = parseWith(mergeBodySchema, req.body);
    return mergeSubject(db, source, targetId);
  });

  app.post('/api/subjects/:id/delete-files', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    // server-side typed confirm: the irreversible action needs the exact name in the body
    const { confirm } = parseWith(deleteFilesBodySchema, req.body);
    if (confirm !== subject.name) {
      throw new HttpError('VALIDATION', `confirmation does not match subject name "${subject.name}"`);
    }
    await deleteSubjectFiles(db, ctx.cfg, subject);
    return { ok: true };
  });

  app.delete('/api/subjects/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    requireSubject(db, id); // unregister only â€” disk is never touched
    subjectsRepo.deleteSubject(db, id);
    return reply.code(204).send();
  });
}
