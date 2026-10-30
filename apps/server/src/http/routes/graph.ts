import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { parseWith } from '../validate.js';
import { markdownBodySchema } from '@studi0/shared';
import { requireSubject, graphStatusFor, computeStale } from '../../subjects/service.js';
import * as jobsRepo from '../../db/repos/jobs.js';
import {
  listWikiPages,
  readWikiPage,
  saveWikiPage,
  readCorrections,
  writeCorrections,
} from '../../graph/wiki.js';
import { safeResolve } from '../../fs/paths.js';
import { HttpError } from '../../util/errors.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
};

export async function registerGraphRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db } = ctx;

  app.get('/api/subjects/:id/graph', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const activeJob = jobsRepo.activeJobForSubject(db, subject.id);
    const root = path.join(subject.path, 'graphify-out');
    return {
      graphStatus: await graphStatusFor(subject, activeJob),
      stale: await computeStale(subject),
      lastBuiltAt: subject.last_built_at,
      hasGraph: existsSync(path.join(root, 'graph.json')),
      hasReport: existsSync(path.join(root, 'GRAPH_REPORT.md')),
      hasVerifyReport: existsSync(path.join(root, 'VERIFY_REPORT.md')),
    };
  });

  app.get('/api/subjects/:id/graph/report', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const read = async (name: string): Promise<string | null> => {
      const abs = path.join(subject.path, 'graphify-out', name);
      return existsSync(abs) ? readFile(abs, 'utf8') : null;
    };
    return {
      graphReport: await read('GRAPH_REPORT.md'),
      verifyReport: await read('VERIFY_REPORT.md'),
    };
  });

  // raw passthrough confined to graphify-out/ â€” serves graph.html + assets to the iframe
  app.get('/api/subjects/:id/graph/raw/*', async (req, reply) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const rel = (req.params as { '*': string })['*'];
    const abs = safeResolve(path.join(subject.path, 'graphify-out'), rel);
    if (!existsSync(abs) || !statSyncSafe(abs)) {
      throw new HttpError('FILE_NOT_FOUND', `file not found: ${rel}`);
    }
    const ext = path.extname(abs).toLowerCase();
    const s = await stat(abs);
    if (s.isDirectory()) throw new HttpError('FILE_NOT_FOUND', `file not found: ${rel}`);
    return reply
      .type(CONTENT_TYPES[ext] ?? 'application/octet-stream')
      .send(await readFile(abs));
  });

  app.get('/api/subjects/:id/wiki', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    return { pages: await listWikiPages(subject) };
  });

  app.get('/api/subjects/:id/wiki/:page', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    return readWikiPage(subject, (req.params as { page: string }).page);
  });

  app.put('/api/subjects/:id/wiki/:page', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const { markdown } = parseWith(markdownBodySchema, req.body);
    return saveWikiPage(subject, (req.params as { page: string }).page, markdown);
  });

  app.get('/api/subjects/:id/corrections', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    return { markdown: await readCorrections(subject) };
  });

  app.put('/api/subjects/:id/corrections', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const { markdown } = parseWith(markdownBodySchema, req.body);
    return { markdown: await writeCorrections(subject, markdown) };
  });
}

function statSyncSafe(abs: string): boolean {
  try {
    return existsSync(abs);
  } catch {
    return false;
  }
}
