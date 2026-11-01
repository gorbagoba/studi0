import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { parseWith } from '../validate.js';
import { courseSetupBodySchema, createSubjectBodySchema, renameSubjectBodySchema } from '@studi0/shared';
import { applySetupToMission } from '../../subjects/mission.js';
import * as subjectsRepo from '../../db/repos/subjects.js';
import {
  requireSubject,
  registerSubject,
  subjectDetail,
  subjectToDto,
  computeStale,
  listSubjectDtos,
} from '../../subjects/service.js';
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
    if (subjectsRepo.getSubjectByName(db, body.name)) {
      throw new HttpError('NAME_TAKEN', `a subject named "${body.name}" already exists`);
    }
    subjectsRepo.renameSubject(db, id, body.name);
    return subjectToDto({ ...row, name: body.name }, await computeStale(row));
  });

  app.delete('/api/subjects/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    requireSubject(db, id); // unregister only â€” disk is never touched
    subjectsRepo.deleteSubject(db, id);
    return reply.code(204).send();
  });
}
