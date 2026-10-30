import path from 'node:path';
import { realpathSync } from 'node:fs';
import { HttpError } from '../util/errors.js';

/**
 * THE choke point for every disk path under a subject root.
 * Resolves `rel` against `root` and refuses anything that escapes it
 * (absolute paths, drive letters, UNC, ..-traversal, NUL bytes).
 */
export function safeResolve(root: string, rel: string): string {
  if (rel === '' || rel === '.') return path.resolve(root);
  const normalized = rel.replaceAll('\\', '/');
  if (
    normalized.includes('\0') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.startsWith('//') ||
    normalized.startsWith('\\\\') ||
    path.isAbsolute(rel)
  ) {
    throw new HttpError('PATH_TRAVERSAL', `path escapes the subject: ${rel}`);
  }
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, normalized);
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) {
    throw new HttpError('PATH_TRAVERSAL', `path escapes the subject: ${rel}`);
  }
  // symlink/junction containment: the real location must stay inside the real root
  try {
    const real = realpathSync(abs);
    const realRoot = realpathSync(absRoot);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new HttpError('PATH_TRAVERSAL', `path escapes the subject: ${rel}`);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // path or root not on disk yet — nothing to traverse through
  }
  return abs;
}

/** True when `abs` is inside `dir` (or is dir itself). */
export function isInside(dir: string, abs: string): boolean {
  const d = path.resolve(dir);
  return abs === d || abs.startsWith(d + path.sep);
}

/** Reject names that could escape or break Windows files (uploads, wiki pages). */
export function sanitizeName(name: string): string {
  const base = name.replaceAll('\\', '/').split('/').pop() ?? '';
  let cleaned = base
    .replace(/[<>:"|?*]/g, '')
    .replace(/\p{Cc}/gu, '')
    .replace(/^\.+/, '')
    .trim();
  // Windows reserves these stems on any extension (CON.txt, NUL, COM1.md...)
  const dot = cleaned.indexOf('.');
  const stem = dot === -1 ? cleaned : cleaned.slice(0, dot);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) cleaned = `_${cleaned}`;
  return (cleaned || 'file').slice(0, 180);
}
