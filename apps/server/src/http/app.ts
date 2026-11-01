import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { makeConfig, type Config } from '../config.js';
import { openDb, type Db } from '../db/index.js';
import { closeStaleRunning, staleRunningPids } from '../db/repos/jobs.js';
import { EventBus } from './sse.js';
import { HttpError } from '../util/errors.js';
import { isAlive, killTreeWithDeadline } from '../util/proc.js';
import { makeOneshot } from '../util/oneshot.js';
import { JobQueue } from '../pipeline/queue.js';
import { makeRunPipeline, type RunPipelineFn } from '../pipeline/runner.js';
import { OpencodeManager } from '../teacher/opencode.js';
import { makeFeedQuestions } from '../teacher/practiceFeed.js';
import type { Ctx } from '../context.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSubjectRoutes } from './routes/subjects.js';
import { registerFileRoutes } from './routes/files.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerGraphRoutes } from './routes/graph.js';
import { registerLessonRoutes } from './routes/lessons.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerPracticeRoutes } from './routes/practice.js';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: Ctx;
}

export function buildApp(opts: { dataDir?: string; dbPath?: string } = {}): BuiltApp {
  const cfg: Config = makeConfig(opts.dataDir);
  const db: Db = openDb(opts.dbPath ?? cfg.dbPath);

  // boot cleanup: kill-tree orphans a previous life left writing, then close their rows honestly
  for (const pid of staleRunningPids(db)) {
    if (isAlive(pid)) killTreeWithDeadline(pid);
  }
  closeStaleRunning(db);

  const events = new EventBus();
  const oc = new OpencodeManager(cfg);
  const oneshot = makeOneshot(cfg);
  const runPipeline: RunPipelineFn = makeRunPipeline(oneshot, db);
  const queue = new JobQueue(db, events, cfg, runPipeline);
  const feedQuestions = makeFeedQuestions(db, events, oneshot);

  const ctx: Ctx = { cfg, db, events, queue, oc, oneshot, runPipeline, feedQuestions };

  const app = Fastify({ logger: true, bodyLimit: cfg.maxFileBytes + 1024 * 1024 });

  // CSRF-class guard: drive-by POSTs from any website. Browsers always send
  // Origin/Sec-Fetch-Site on such requests; header-absent clients (curl, tests) pass.
  // The Host allowlist additionally blocks DNS-rebinding pages, whose fetches are
  // legitimately "same-origin" (Fetch Metadata cannot see them) but carry an
  // attacker-controlled Host header they cannot spoof.
  app.addHook('onRequest', async (req, reply) => {
    const mutating = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE';
    if (!mutating) return;
    const reject = () =>
      reply.status(403).send({ error: { code: 'VALIDATION', message: 'cross-origin request rejected' } });
    const allowedHosts = [
      `127.0.0.1:${cfg.port}`,
      `localhost:${cfg.port}`,
      '127.0.0.1:5173',
      'localhost:5173',
      '127.0.0.1:4173',
      'localhost:4173',
      // light-my-request's default Host in tests — localhost itself is trusted
      'localhost:80',
      '127.0.0.1:80',
    ];
    const host = req.headers.host ?? '';
    if (!allowedHosts.includes(host)) return reject();
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (origin === undefined && site === undefined) return;
    const allowedOrigins = allowedHosts.map((h) => `http://${h}`);
    if (origin !== undefined && !allowedOrigins.includes(origin)) return reject();
    if (site === 'cross-site' || site === 'same-site') return reject();
  });

  app.register(multipart, {
    limits: { fileSize: cfg.maxFileBytes, files: 100 },
  });

  app.setErrorHandler((err, req, reply) => {
    const error = err as Error & { statusCode?: number };
    if (error instanceof HttpError) {
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'invalid request' } });
    }
    if (error.statusCode === 413 || /body limit/i.test(error.message)) {
      return reply
        .status(413)
        .send({ error: { code: 'VALIDATION', message: 'request body too large' } });
    }
    // malformed/empty JSON bodies are client mistakes, not server faults
    const fstCode = (error as { code?: unknown }).code;
    if (typeof fstCode === 'string' && fstCode.startsWith('FST_ERR_CTP_')) {
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION', message: 'malformed request body' } });
    }
    req.log.error(error);
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL', message: 'internal server error' } });
  });

  registerHealthRoutes(app, ctx);
  registerSubjectRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerGraphRoutes(app, ctx);
  registerLessonRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerPracticeRoutes(app, ctx);

  return { app, ctx };
}
