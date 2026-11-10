import type { FastifyInstance } from 'fastify';
import type { Health } from '@studi0/shared';
import type { Ctx } from '../../context.js';
import { activeSetupRuns } from '../../subjects/setupRun.js';
import { activeActivities, type Activity } from '../../teacher/activity.js';

/** Live agent/monitor snapshot (setup runs, chat turns + non-terminal pipeline jobs). */
interface AgentStatus {
  busy: boolean;
  task: {
    kind: 'lesson-generation' | 'chat';
    subjectId: string;
    subjectName: string;
    startedAt: string;
  } | null;
  jobs: Array<
    | {
        id: string;
        kind: 'build' | 'update' | 'recluster';
        subject: string;
        status: 'queued' | 'running' | 'cancelling';
        done: number;
        total: number;
      }
    | Pick<Activity, 'id' | 'kind' | 'subjectId' | 'subjectName' | 'startedAt'>
  >;
}

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

  // live monitor: headless setup runs, in-flight chat turns + non-terminal pipeline jobs
  app.get('/api/agent/status', async (): Promise<AgentStatus> => {
    const runs = activeSetupRuns();
    const activities = activeActivities();
    const newest = activities.reduce<Activity | null>(
      (a, b) => (!a || b.startedAt >= a.startedAt ? b : a),
      null,
    );
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
      busy: runs.length > 0 || activities.length > 0 || jobs.length > 0,
      task: runs[0]
        ? { kind: 'lesson-generation', ...runs[0] }
        : newest
          ? {
              kind: newest.kind,
              subjectId: newest.subjectId,
              subjectName: newest.subjectName,
              startedAt: newest.startedAt,
            }
          : null,
      jobs: [
        ...jobs.map((j) => ({
          id: j.id,
          subject: j.subject,
          kind: j.kind,
          status: j.status,
          done: j.progress_done,
          total: j.progress_total,
        })),
        ...activities.map(({ id, kind, subjectId, subjectName, startedAt }) => ({
          id,
          kind,
          subjectId,
          subjectName,
          startedAt,
        })),
      ],
    };
  });

  // restart only the teacher service; the API process itself keeps running.
  // boot() alone is the atomic operation: cleanupZombie + start (stop+boot could
  // leave the teacher down if boot fails, and races the probe loop's own reboot)
  app.post('/api/teacher/restart', async (_req, reply) => {
    await ctx.oc.boot();
    return reply.code(200).send({ ok: true, opencode: ctx.oc.status() });
  });

  // clean shutdown via the SIGTERM path (drains jobs, stops opencode, closes db)
  app.post('/api/shutdown', async (_req, reply) => {
    void reply.send({ ok: true });
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50).unref();
  });
}
