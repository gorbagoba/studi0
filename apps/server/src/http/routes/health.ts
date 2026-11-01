import type { FastifyInstance } from 'fastify';
import type { Health } from '@studi0/shared';
import type { Ctx } from '../../context.js';

export async function registerHealthRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get('/api/health', async (): Promise<Health> => ({
    ok: true,
    opencode: ctx.oc.status(),
  }));

  // clean shutdown via the SIGTERM path (drains jobs, stops opencode, closes db)
  app.post('/api/shutdown', async (_req, reply) => {
    void reply.send({ ok: true });
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50).unref();
  });
}
