import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { copyFile, lstat, mkdir, readdir, realpath, rm, stat, unlink } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import * as filesRepo from '../db/repos/files.js';
import * as subjectsRepo from '../db/repos/subjects.js';
import * as jobsRepo from '../db/repos/jobs.js';
import { killTreeWithDeadline } from '../util/proc.js';
import { safeResolve, sanitizeName, isInside } from '../fs/paths.js';
import { renameWithRetry } from '../fs/safeWrite.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../util/errors.js';
import type { FileEntry, FileRow as FileRowDto, TreeDir } from '@studi0/shared';
import type { SubjectRow } from '../db/repos/subjects.js';

const TREE_ROOTS: TreeDir[] = ['material', 'lessons', 'reference', 'graphify-out'];

function toEntry(subjectRoot: string, abs: string, isDir: boolean, id?: string): FileEntry {
  const rel = path.relative(subjectRoot, abs).replaceAll('\\', '/');
  const name = path.basename(abs);
  const s = statSync(abs);
  return {
    ...(id !== undefined ? { id } : {}),
    path: rel,
    dir: path.dirname(rel).replaceAll('\\', '/'),
    name,
    ext: isDir ? '' : path.extname(name).toLowerCase(),
    bytes: isDir ? 0 : s.size,
    mtime: s.mtime.toISOString(),
  };
}

export async function listTree(db: Db, subject: SubjectRow, dirParam?: string) {
  const root = subject.path;
  if (!dirParam) {
    // root listing: the four allowlisted roots (directories — no file rows involved)
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
  // material/ files carry their row id (context menus act per-file via /api/files/:fileId)
  const idByRel = new Map(
    filesRepo.listSubjectFiles(db, subject.id).map((r) => [r.rel_path, r.id] as const),
  );
  const entries = raw
    .filter((e) => e.isFile() || e.isDirectory())
    .map((e) => {
      const entryAbs = path.join(abs, e.name);
      const entryRel = path.relative(root, entryAbs).replaceAll('\\', '/');
      return toEntry(root, entryAbs, e.isDirectory(), idByRel.get(entryRel));
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return { dir: rel, entries };
}

/** Resolve a collision-free destination for an uploaded basename. */
function uploadTarget(subject: SubjectRow, filename: string): { abs: string; rel: string } {
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
    // EEXIST = a concurrent upload won the name — deleting would kill its file
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      await rm(target.abs, { force: true });
    }
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

export interface SplitPdfResult {
  parts: string[];
}

function runPython(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const isWin = process.platform === 'win32';
  const run = (bin: string, a: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(bin, a, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      // cap collected output — the only place a hostile file drives a first-party parser
      const MAX_CAPTURE = 1024 * 1024;
      let captured = 0;
      const collect = (buf: Buffer[], d: Buffer) => {
        if (captured < MAX_CAPTURE) {
          buf.push(d);
          captured += d.length;
        }
      };
      child.stdout?.on('data', (d: Buffer) => collect(stdout, d));
      child.stderr?.on('data', (d: Buffer) => collect(stderr, d));
      const timer = setTimeout(() => {
        if (child.pid !== undefined) killTreeWithDeadline(child.pid);
        else child.kill();
      }, timeoutMs);
      timer.unref();
      // spawn reports ENOENT asynchronously — walk the chain: POSIX distros name
      // it python3 or python; Windows falls back to the py launcher
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') {
          reject(err);
          return;
        }
        if (bin === 'python3') resolve(run('python', a));
        else if (bin === 'python' && isWin) resolve(run('py', ['-3', ...a]));
        else reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });
  return run(isWin ? 'python' : 'python3', args);
}

/**
 * Split material/<relFile> into ~targetBytes parts next to the original
 * (apps/server/scripts/split_pdf.py, pypdf). Original untouched; file rows
 * synced like uploads. Files already at or below the target are returned
 * unsplit (parts = [original]).
 */
export async function splitPdf(
  db: Db,
  subject: SubjectRow,
  targetBytes: number,
  relFile: string,
): Promise<SplitPdfResult> {
  if (path.extname(relFile).toLowerCase() !== '.pdf') {
    throw new HttpError('UNSUPPORTED_FILE_TYPE', `pdf split needs a .pdf file: ${relFile}`);
  }
  const materialDir = safeResolve(subject.path, 'material');
  const abs = safeResolve(subject.path, relFile); // traversal hard gate
  if (!isInside(materialDir, abs)) {
    throw new HttpError('PATH_TRAVERSAL', `file must live under material/: ${relFile}`);
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new HttpError('FILE_NOT_FOUND', `file not found: ${relFile}`);
  }
  const toRel = (p: string) => path.relative(subject.path, p).replaceAll('\\', '/');
  if (statSync(abs).size <= targetBytes) {
    return { parts: [toRel(abs)] };
  }
  const script = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'split_pdf.py');
  const res = await runPython([script, abs, path.dirname(abs), String(targetBytes)], 120_000);
  if (res.code !== 0) {
    const tail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    console.error(`[split-pdf ${relFile}] exited ${res.code}: ${tail || 'no stderr'}`);
    // internals (local paths, library noise) stay server-side — match the runner's pattern
    throw new HttpError('INTERNAL', `pdf split failed (see server log)`);
  }
  const parsed = JSON.parse(res.stdout) as { parts?: unknown };
  if (!Array.isArray(parsed.parts) || parsed.parts.length === 0) {
    throw new HttpError('INTERNAL', 'pdf split produced no parts');
  }
  const parts: string[] = [];
  for (const p of parsed.parts) {
    if (typeof p !== 'string' || !isInside(materialDir, path.resolve(p))) {
      throw new HttpError('INTERNAL', 'pdf split reported a part outside material/');
    }
    const s = await stat(p);
    const rel = toRel(p);
    filesRepo.upsertFile(db, {
      subject_id: subject.id,
      rel_path: rel,
      bytes: s.size,
      mtime: s.mtime.toISOString(),
      origin: 'upload',
    });
    parts.push(rel);
  }
  return { parts };
}

// ---- WAVE3: cross-subject file moves + typed-confirm disk delete ----

/** Move one file on disk: rename with lock retry; copy+delete across volumes (EXDEV). */
async function movePreserving(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  try {
    await renameWithRetry(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await copyFile(from, to);
    await unlink(from);
  }
}

export interface MergeResult {
  moved: string[];
  skipped: string[];
}

/**
 * Merge `source` INTO `target`: every material/ file currently registered under
 * the source moves into the target's material/ (same relative path). Name
 * collisions are skipped and reported; lessons/reference/learning-records/
 * graphify-out are outputs and stay with their subject. The source subject
 * stays registered (material-empty), its graph untouched.
 */
export async function mergeSubject(db: Db, source: SubjectRow, targetId: string): Promise<MergeResult> {
  if (targetId === source.id) {
    throw new HttpError('VALIDATION', 'cannot merge a subject into itself');
  }
  const target = subjectsRepo.getSubject(db, targetId);
  if (!target) throw new HttpError('SUBJECT_NOT_FOUND', `subject ${targetId} not found`);
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const row of filesRepo.listSubjectFiles(db, source.id)) {
    if (!row.rel_path.startsWith('material/')) continue;
    try {
      // resolution inside the try — one hostile-geometry row must not abort the merge
      const from = safeResolve(source.path, row.rel_path);
      const to = safeResolve(target.path, row.rel_path);
      if (existsSync(to)) {
        skipped.push(row.rel_path); // collision — the target's file wins
        continue;
      }
      await movePreserving(from, to);
    } catch (e) {
      console.warn(`[merge] could not move ${row.rel_path}: ${(e as Error).message}`);
      skipped.push(row.rel_path);
      continue;
    }
    filesRepo.repointFile(db, row.id, target.id, row.rel_path);
    moved.push(row.rel_path);
  }
  return { moved, skipped };
}

/** Move one registered material/ file (row + disk file) into the target subject. */
/** Rename a material/ file on disk and re-point its row. */
export async function renameFile(
  db: Db,
  row: filesRepo.FileRow,
  subject: SubjectRow,
  newName: string,
): Promise<FileRowDto> {
  if (!row.rel_path.startsWith('material/')) {
    throw new HttpError('VALIDATION', 'only material/ files can be renamed here');
  }
  const safe = sanitizeName(newName);
  const toRel = `material/${safe}`;
  const from = safeResolve(subject.path, row.rel_path);
  const to = safeResolve(subject.path, toRel);
  if (existsSync(to)) {
    throw new HttpError('NAME_TAKEN', `a file named "${safe}" already exists`);
  }
  await movePreserving(from, to);
  filesRepo.repointFile(db, row.id, subject.id, toRel);
  const s = await stat(to);
  return {
    id: row.id,
    subjectId: subject.id,
    path: toRel,
    dir: 'material',
    name: safe,
    ext: path.extname(safe).toLowerCase(),
    bytes: s.size,
    mtime: s.mtime.toISOString(),
    origin: row.origin,
  };
}

/** Delete a material/ file from disk and remove its row. */
export async function deleteFileById(
  db: Db,
  row: filesRepo.FileRow,
  subject: SubjectRow,
): Promise<{ ok: true }> {
  if (!row.rel_path.startsWith('material/')) {
    throw new HttpError('VALIDATION', 'only material/ files can be deleted here');
  }
  const abs = safeResolve(subject.path, row.rel_path);
  if (!existsSync(abs)) {
    throw new HttpError('FILE_NOT_FOUND', `file not found: ${row.rel_path}`);
  }
  await rm(abs);
  filesRepo.deleteFile(db, row.id);
  return { ok: true };
}

export async function moveFileBetweenSubjects(
  db: Db,
  row: filesRepo.FileRow,
  source: SubjectRow,
  target: SubjectRow,
): Promise<FileRowDto> {
  if (!row.rel_path.startsWith('material/')) {
    throw new HttpError('VALIDATION', 'only material/ files can be moved between subjects');
  }
  const from = safeResolve(source.path, row.rel_path);
  const to = safeResolve(target.path, row.rel_path);
  if (existsSync(to)) {
    throw new HttpError(
      'NAME_TAKEN',
      `a file named "${path.basename(row.rel_path)}" already exists in "${target.name}"`,
    );
  }
  await movePreserving(from, to);
  filesRepo.repointFile(db, row.id, target.id, row.rel_path);
  const s = await stat(to);
  return {
    id: row.id,
    subjectId: target.id,
    path: row.rel_path,
    dir: path.posix.dirname(row.rel_path),
    name: path.basename(row.rel_path),
    ext: path.extname(row.rel_path).toLowerCase(),
    bytes: s.size,
    mtime: s.mtime.toISOString(),
    origin: row.origin,
  };
}

/**
 * Typed-confirm disk delete: refuse while a job is active, then verify the
 * folder on disk still realpaths to the registered path (a junction/symlink
 * swap refuses) before rm -rf of the subject ROOT — material, lessons,
 * graphify-out, everything. Irreversible. Closes file rows and unregisters.
 */
export async function deleteSubjectFiles(db: Db, cfg: Config, subject: SubjectRow): Promise<void> {
  if (jobsRepo.activeJobForSubject(db, subject.id)) {
    throw new HttpError(
      'JOB_CONFLICT',
      'a job is queued/running on this subject — cancel it or wait for it to finish',
    );
  }
  const stored = path.resolve(subject.path);
  let real: string;
  try {
    real = await realpath(stored);
  } catch {
    throw new HttpError('PATH_NOT_FOUND', `subject folder is no longer on disk: ${subject.path}`);
  }
  const norm = (p: string) => p.replaceAll('/', '\\').toLowerCase();
  // A leaf reparse point (junction/symlink swap) must refuse on its own merits —
  // only ANCESTOR divergence is environmental (macOS /var) and tolerated.
  const realLeaf = await lstat(stored);
  if (realLeaf.isSymbolicLink()) {
    throw new HttpError('PATH_TRAVERSAL', 'subject folder root is a symlink/junction — refusing to delete');
  }
  const realParent = norm(path.dirname(real));
  const storedParent = norm(path.dirname(stored));
  if (realParent !== storedParent && !isInside(cfg.subjectsDir, storedParent)) {
    throw new HttpError(
      'PATH_TRAVERSAL',
      'subject folder no longer resolves to its registered path — refusing to delete',
    );
  }
  await rm(stored, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  subjectsRepo.deleteSubject(db, subject.id); // disk is gone; this closes the rows
}
