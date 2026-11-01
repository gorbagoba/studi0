import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { requireSubject } from '../../subjects/service.js';
import { listTree, renameFile, deleteFileById, saveUpload, splitPdf, moveFileBetweenSubjects } from '../../subjects/files.js';
import { parseWith } from '../validate.js';
import { moveFileBodySchema, renameFileBodySchema, splitPdfBodySchema } from '@studi0/shared';
import { HttpError } from '../../util/errors.js';
import type { FileEntry } from '@studi0/shared';
import * as filesRepo from '../../db/repos/files.js';

export async function registerFileRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db, cfg } = ctx;

  app.get('/api/subjects/:id/tree', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const dir = (req.query as { dir?: string }).dir;
    return listTree(db, subject, dir);
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

  app.post('/api/subjects/:id/split-pdf', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const { file } = parseWith(splitPdfBodySchema, req.body);
    return splitPdf(db, subject, cfg.splitTargetBytes, file);
  });

  app.post('/api/files/:fileId/move', async (req) => {
    const { targetSubjectId } = parseWith(moveFileBodySchema, req.body);
    const row = filesRepo.getFile(db, (req.params as { fileId: string }).fileId);
    if (!row) throw new HttpError('FILE_NOT_FOUND', `file ${(req.params as { fileId: string }).fileId} not found`);
    const source = requireSubject(db, row.subject_id);
    const target = requireSubject(db, targetSubjectId);
    return moveFileBetweenSubjects(db, row, source, target);
  });

  app.patch('/api/files/:fileId', async (req) => {
    const { name } = parseWith(renameFileBodySchema, req.body);
    const row = filesRepo.getFile(db, (req.params as { fileId: string }).fileId);
    if (!row) throw new HttpError('FILE_NOT_FOUND', `file ${(req.params as { fileId: string }).fileId} not found`);
    const subject = requireSubject(db, row.subject_id);
    return renameFile(db, row, subject, name);
  });

  app.delete('/api/files/:fileId', async (req) => {
    const row = filesRepo.getFile(db, (req.params as { fileId: string }).fileId);
    if (!row) throw new HttpError('FILE_NOT_FOUND', `file ${(req.params as { fileId: string }).fileId} not found`);
    const subject = requireSubject(db, row.subject_id);
    return deleteFileById(db, row, subject);
  });
}
