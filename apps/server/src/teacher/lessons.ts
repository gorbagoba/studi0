import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as lessonsRepo from '../db/repos/lessons.js';
import type { Db } from '../db/index.js';
import type { SubjectRow } from '../db/repos/subjects.js';
import type { EventBus } from '../http/sse.js';

export interface LessonMarker {
  nodes: string[];
  topic: string;
}

/** First-line marker: <!-- studi0:lesson {"nodes":[...],"topic":"..."} --> */
export function parseLessonMarker(html: string): LessonMarker | null {
  const first = html.slice(0, 2000);
  const m = first.match(/<!--\s*studi0:lesson\s*(\{[\s\S]*?\})\s*-->/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]) as { nodes?: unknown; topic?: unknown };
    return {
      nodes: Array.isArray(obj.nodes) ? obj.nodes.filter((n): n is string => typeof n === 'string') : [],
      topic: typeof obj.topic === 'string' ? obj.topic : '',
    };
  } catch {
    return null;
  }
}

export function extractTitle(html: string, fallback: string): string {
  const t = html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (!t) return fallback;
  const text = t.replace(/<[^>]+>/g, '').trim();
  // titles carry HTML entities (&amp; in "Heaps &amp; Priority Queues") — decode the common set
  const decoded = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return decoded || fallback;
}

/** Escape a plain title for HTML text content. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Retitle a lesson's HTML in place: first <title>, else a <title> in <head>,
 * plus the first <h1> text. A boot re-index reads these, so the file must match.
 */
export function rewriteLessonTitle(html: string, title: string): string {
  const escaped = escapeHtml(title);
  let out = html;
  if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(out)) {
    out = out.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, () => `<title>${escaped}</title>`);
  } else {
    out = out.replace(/<head\b[^>]*>/i, (head) => `${head}<title>${escaped}</title>`);
  }
  return out.replace(
    /<h1\b([^>]*)>[\s\S]*?<\/h1>/i,
    (_m, attrs: string) => `<h1${attrs}>${escaped}</h1>`,
  );
}

/** Snapshot of lessons/ as relPath → mtime ISO. */
export async function snapshotLessons(subject: SubjectRow): Promise<Map<string, string>> {
  const dir = path.join(subject.path, 'lessons');
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.html')) continue;
    const abs = path.join(dir, entry.name);
    out.set(`lessons/${entry.name}`, (await stat(abs)).mtime.toISOString());
  }
  return out;
}

/** Index + emit every lesson created or changed since `before`. */
export async function detectAndIndexLessons(
  db: Db,
  subject: SubjectRow,
  before: Map<string, string>,
  events: EventBus,
): Promise<lessonsRepo.LessonRow[]> {
  const after = await snapshotLessons(subject);
  const changed = [...after.entries()].filter(([p, m]) => before.get(p) !== m);
  const rows: lessonsRepo.LessonRow[] = [];
  for (const [relPath] of changed) {
    const abs = path.join(subject.path, relPath);
    try {
      const html = await readFile(abs, 'utf8');
      const marker = parseLessonMarker(html);
      const title = extractTitle(html, path.basename(relPath, '.html'));
      const row = lessonsRepo.upsertLesson(db, subject.id, relPath, title, marker?.nodes ?? []);
      rows.push(row);
      events.emit(subject.id, 'lesson', lessonsRepo.lessonToDto(row));
    } catch {
      // unreadable lesson file — skip indexing, teacher will rewrite
    }
  }
  // consume the diff: a caller that re-detects later (native write_lesson →
  // end-of-turn safety net) must not double-index the same files
  for (const [p, m] of after) before.set(p, m);
  return rows;
}
