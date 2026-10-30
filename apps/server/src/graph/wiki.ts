import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { safeResolve, sanitizeName } from '../fs/paths.js';
import { safeWriteFile } from '../fs/safeWrite.js';
import type { SubjectRow } from '../db/repos/subjects.js';
import { HttpError } from '../util/errors.js';

const wikiDir = (subject: SubjectRow): string => safeResolve(subject.path, 'graphify-out/wiki');

export async function listWikiPages(subject: SubjectRow): Promise<{ name: string; updatedAt: string }[]> {
  const dir = wikiDir(subject);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const pages = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
    const s = await stat(path.join(dir, e.name));
    pages.push({ name: e.name, updatedAt: s.mtime.toISOString() });
  }
  return pages.sort((a, b) => a.name.localeCompare(b.name));
}

function wikiPageAbs(subject: SubjectRow, page: string): string {
  const name = sanitizeName(page.endsWith('.md') ? page : `${page}.md`);
  return safeResolve(wikiDir(subject), name);
}

export async function readWikiPage(
  subject: SubjectRow,
  page: string,
): Promise<{ name: string; markdown: string; updatedAt: string }> {
  const abs = wikiPageAbs(subject, page);
  if (!existsSync(abs)) throw new HttpError('FILE_NOT_FOUND', `wiki page not found: ${page}`);
  const [markdown, s] = await Promise.all([readFile(abs, 'utf8'), stat(abs)]);
  return { name: path.basename(abs), markdown, updatedAt: s.mtime.toISOString() };
}

/** Edit-only: PUT never creates pages (free-form knowledge belongs in corrections.md). */
export async function saveWikiPage(
  subject: SubjectRow,
  page: string,
  markdown: string,
): Promise<{ name: string; updatedAt: string }> {
  const abs = wikiPageAbs(subject, page);
  if (!existsSync(abs)) throw new HttpError('FILE_NOT_FOUND', `wiki page not found: ${page}`);
  await safeWriteFile(abs, markdown);
  const s = await stat(abs);
  return { name: path.basename(abs), updatedAt: s.mtime.toISOString() };
}

export async function readCorrections(subject: SubjectRow): Promise<string> {
  const abs = safeResolve(subject.path, 'corrections.md');
  if (!existsSync(abs)) return '';
  return readFile(abs, 'utf8');
}

export async function writeCorrections(subject: SubjectRow, markdown: string): Promise<string> {
  const abs = safeResolve(subject.path, 'corrections.md');
  await safeWriteFile(abs, markdown);
  return markdown;
}
