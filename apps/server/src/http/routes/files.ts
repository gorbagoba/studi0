import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { requireSubject } from '../../subjects/service.js';
import { listTree, saveUpload } from '../../subjects/files.js';
import { HttpError } from '../../util/errors.js';
import type { FileEntry } from '@studi0/shared';

export async function registerFileRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db, cfg } = ctx;

  app.get('/api/subjects/:id/tree', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const dir = (req.query as { dir?: string }).dir;
    return listTree(subject, dir);
  });

  app.post('/api/subjects/:id/files', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    if (!req.isMultipart()) {
      throw new HttpError('VALIDATION', 'expected multipart/form-data with a "files" field');
    }
    const accepted: FileEntry[] = [];
    const rejected: { name: string; reason: string }[] = [];
    let sawAny = false;
    for await (const part of req.files()) {
      sawAny = true;
      const outcome = await saveUpload(
        db,
        subject,
        part.filename,
        part.file,
        cfg.allowedExt,
        cfg.maxFileBytes,
      );
      if (outcome.ok) accepted.push(outcome.entry);
      else rejected.push({ name: part.filename, reason: outcome.reason });
    }
    if (!sawAny) throw new HttpError('VALIDATION', 'no files in request');
    // 415 only when nothing at all was acceptable (contract); envelope per error format
    if (accepted.length === 0) {
      throw new HttpError(
        'UNSUPPORTED_FILE_TYPE',
        rejected.map((r) => `${r.name}: ${r.reason}`).join('; ') || 'no acceptable files',
        { rejected },
      );
    }
    return { accepted, rejected };
  });
}
