import type { FastifyInstance } from 'fastify';
import type { Health } from '@studi0/shared';
import type { Ctx } from '../../context.js';

export async function registerHealthRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get('/api/health', async (): Promise<Health> => {
    const jobs = ctx.db
      .prepare(
        `SELECT j.id, j.kind, j.status, j.progress_done, j.progress_total, s.name AS subject
         FROM jobs j JOIN subjects s ON s.id = j.subject_id
         WHERE j.status IN ('queued', 'running', 'cancelling')
         ORDER BY j.created_at`,
      )
      .all() as Array<{
      id: string;
      kind: 'build' | 'update' | 'recluster';
      status: 'queued' | 'running' | 'cancelling';
      progress_done: number;
      progress_total: number;
      subject: string;
    }>;
    return {
      ok: true,
      opencode: ctx.oc.status(),
      uptime_s: Math.round(process.uptime()),
      db: typeof ctx.db.prepare('SELECT 1').get() === 'object' ? 'ok' : 'error',
      probed_at: new Date().toISOString(),
      jobs: jobs.map((j) => ({
        id: j.id,
        subject: j.subject,
        kind: j.kind,
        status: j.status,
        done: j.progress_done,
        total: j.progress_total,
      })),
    };
  });

  // restart only the teacher service; the API process itself keeps running
  app.post('/api/teacher/restart', async (_req, reply) => {
    await ctx.oc.stop();
    await ctx.oc.boot();
    return reply.code(200).send({ ok: true, opencode: ctx.oc.status() });
  });

  // clean shutdown via the SIGTERM path (drains jobs, stops opencode, closes db)
  app.post('/api/shutdown', async (_req, reply) => {
    void reply.send({ ok: true });
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50).unref();
  });
}
