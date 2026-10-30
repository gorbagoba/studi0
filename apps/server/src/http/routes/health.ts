import type { Health } from '@studi0/shared';
import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (): Promise<Health> => ({ ok: true }));
}
