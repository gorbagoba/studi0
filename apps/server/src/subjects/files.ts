import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { readdir, stat, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import * as filesRepo from '../db/repos/files.js';
import { safeResolve, sanitizeName, isInside } from '../fs/paths.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../util/errors.js';
import type { FileEntry, TreeDir } from '@studi0/shared';
import type { SubjectRow } from '../db/repos/subjects.js';

export const TREE_ROOTS: TreeDir[] = ['material', 'lessons', 'reference', 'graphify-out'];

function toEntry(subjectRoot: string, abs: string, isDir: boolean): FileEntry {
  const rel = path.relative(subjectRoot, abs).replaceAll('\\', '/');
  const name = path.basename(abs);
  const s = statSync(abs);
  return {
    path: rel,
    dir: path.dirname(rel).replaceAll('\\', '/'),
    name,
    ext: isDir ? '' : path.extname(name).toLowerCase(),
    bytes: isDir ? 0 : s.size,
    mtime: s.mtime.toISOString(),
  };
}

export async function listTree(subject: SubjectRow, dirParam?: string) {
  const root = subject.path;
  if (!dirParam) {
    // root listing: the four allowlisted roots
    const entries: FileEntry[] = TREE_ROOTS.filter((d) =>
      existsSync(path.join(root, d)),
    ).map((d) => toEntry(root, path.join(root, d), true));
    return { dir: '', entries };
  }
  const abs = safeResolve(root, dirParam);
  if (!isInside(root, abs) || !existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new HttpError('FILE_NOT_FOUND', `directory not found: ${dirParam}`);
  }
  const rel = path.relative(root, abs).replaceAll('\\', '/');
  if (rel !== '' && !TREE_ROOTS.some((t) => t === rel || rel.startsWith(`${t}/`))) {
    throw new HttpError('PATH_TRAVERSAL', `directory is not browsable: ${dirParam}`);
  }
  const raw = await readdir(abs, { withFileTypes: true });
  const entries = raw
    .filter((e) => e.isFile() || e.isDirectory())
    .map((e) => toEntry(root, path.join(abs, e.name), e.isDirectory()))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { dir: rel, entries };
}

/** Resolve a collision-free destination for an uploaded basename. */
export function uploadTarget(subject: SubjectRow, filename: string): { abs: string; rel: string } {
  const name = sanitizeName(filename);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || 'file';
  const materialDir = safeResolve(subject.path, 'material');
  let candidate = `${stem}${ext}`;
  let n = 1;
  while (existsSync(path.join(materialDir, candidate))) {
    candidate = `${stem}-${n}${ext}`;
    n++;
  }
  return { abs: path.join(materialDir, candidate), rel: `material/${candidate}` };
}

export type UploadOutcome =
  | { ok: true; entry: FileEntry }
  | { ok: false; reason: string; unsupported: boolean };

/** Stream one uploaded file into material/ (never buffered whole). */
export async function saveUpload(
  db: Db,
  subject: SubjectRow,
  filename: string,
  stream: Readable,
  allowedExt: string[],
  maxFileBytes: number,
): Promise<UploadOutcome> {
  const ext = path.extname(filename).toLowerCase();
  if (!allowedExt.includes(ext)) {
    // drain the rejected stream — an unconsumed part stalls the multipart iterator
    await new Promise<void>((resolve) => {
      stream.on('end', resolve);
      stream.on('error', resolve);
      stream.resume();
    });
    return { ok: false, reason: `unsupported type "${ext || '(none)'}" — only ${allowedExt.join(' and ')}`, unsupported: true };
  }
  const target = uploadTarget(subject, filename);
  const ws = createWriteStream(target.abs, { flags: 'wx' });
  let bytes = 0;
  stream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxFileBytes) stream.destroy(new Error('file too large'));
  });
  try {
    await pipeline(stream, ws);
  } catch (e) {
    await rm(target.abs, { force: true });
    const msg = e instanceof Error && e.message === 'file too large' ? 'exceeds 200 MB limit' : 'write failed';
    return { ok: false, reason: msg, unsupported: false };
  }  const s = await stat(target.abs);
  const entry: FileEntry = {
    path: target.rel,
    dir: 'material',
    name: path.basename(target.rel),
    ext,
    bytes: s.size,
    mtime: s.mtime.toISOString(),
  };
  filesRepo.upsertFile(db, {
    subject_id: subject.id,
    rel_path: target.rel,
    bytes: s.size,
    mtime: entry.mtime,
    origin: 'upload',
  });
  return { ok: true, entry };
}
