import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { parseWith } from '../validate.js';
import { createJobBodySchema } from '@studi0/shared';
import * as jobsRepo from '../../db/repos/jobs.js';
import { requireSubject } from '../../subjects/service.js';
import { sseReply } from '../sse.js';
import { HttpError } from '../../util/errors.js';

export async function registerJobRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db, queue, events, cfg } = ctx;

  app.post('/api/subjects/:id/jobs', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = parseWith(createJobBodySchema, req.body);
    requireSubject(db, id); // 404 before conflict check
    const job = queue.enqueue(id, body.kind);
    return reply.code(202).send(job);
  });

  app.get('/api/jobs', async (req) => {
    const q = req.query as { subjectId?: string; active?: string };
    return jobsRepo
      .listJobs(db, { subjectId: q.subjectId, activeOnly: q.active === 'true' })
      .map(jobsRepo.jobToDto);
  });

  app.get('/api/jobs/:id', async (req) => {
    const row = jobsRepo.getJob(db, (req.params as { id: string }).id);
    if (!row) throw new HttpError('JOB_NOT_FOUND', 'job not found');
    return jobsRepo.jobToDto(row);
  });

  app.post('/api/jobs/:id/cancel', async (req) => {
    return queue.cancel((req.params as { id: string }).id);
  });

  app.get('/api/subjects/:id/events', async (req, reply) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const send = sseReply(reply, cfg);
    const unsubscribe = events.subscribe(subject.id, send);
    req.raw.on('close', unsubscribe);
  });
}
