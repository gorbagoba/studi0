import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { readdir, stat, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import * as filesRepo from '../db/repos/files.js';
import { killTreeWithDeadline } from '../util/proc.js';
import { safeResolve, sanitizeName, isInside } from '../fs/paths.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../util/errors.js';
import type { FileEntry, TreeDir } from '@studi0/shared';
import type { SubjectRow } from '../db/repos/subjects.js';

const TREE_ROOTS: TreeDir[] = ['material', 'lessons', 'reference', 'graphify-out'];

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
