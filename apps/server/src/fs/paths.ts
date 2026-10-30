import path from 'node:path';
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
  const cleaned = base
    .replace(/[<>:"|?*]/g, '')
    .replace(/\p{Cc}/gu, '')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || 'file').slice(0, 180);
}
