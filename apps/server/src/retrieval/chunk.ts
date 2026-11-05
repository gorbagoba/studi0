import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface Chunk {
  id: string;
  relPath: string;
  /** contextual header, Anthropic-style: `[Course file: <relpath> — <section>]` */
  title: string;
  text: string;
}

/** text-extractable material extensions */
const TEXT_EXT = new Set(['.md', '.txt', '.html', '.csv', '.json']);
const TARGET_CHARS = 2400; // ~600 tokens at ~4 chars/token

interface SourceFile {
  relPath: string;
  abs: string;
  kind: 'md' | 'html' | 'plain';
}

interface Section {
  heading: string;
  paras: string[];
}

function header(relPath: string, heading: string): string {
  const h = heading.trim() || path.basename(relPath);
  return `[Course file: ${relPath} — ${h.slice(0, 120)}]`;
}

function chunkId(relPath: string, text: string): string {
  return createHash('sha1').update(relPath).update('\0').update(text).digest('hex').slice(0, 16);
}

/** strip tags + decode the common HTML entities (same set as teacher/lessons) */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** markdown → sections keyed by # headings; soft-wrapped lines join into paragraphs */
function markdownSections(text: string): Section[] {
  const sections: Section[] = [{ heading: '', paras: [] }];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) {
      sections.push({ heading: m[1], paras: [] });
      continue;
    }
    const cur = sections[sections.length - 1];
    if (line.trim() === '') {
      if (cur.paras.length > 0) cur.paras.push('');
    } else if (cur.paras.length > 0 && cur.paras[cur.paras.length - 1] !== '') {
      cur.paras[cur.paras.length - 1] += ` ${line.trim()}`;
    } else {
      cur.paras.push(line.trim());
    }
  }
  return sections.map((s) => ({ heading: s.heading, paras: s.paras.filter((p) => p) }));
}

/** html → sections keyed by h1-h6 / title; block tags become paragraph breaks */
function htmlSections(html: string, fallback: string): Section[] {
  let fileHeading = '';
  const withMarkers = html
    .replace(/<title[^>]*>([\s\S]*?)<\/title>/i, (_m, t: string) => {
      fileHeading = htmlToText(t).trim();
      return '';
    })
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, _lvl: string, t: string) => {
      const text = htmlToText(t).trim();
      if (!text) return '';
      if (!fileHeading) fileHeading = text;
      return `\u0000${text}\u0000`;
    })
    .replace(/<\/(p|div|section|li|tr|blockquote|pre)>/gi, '\n\n');
  const parts = htmlToText(withMarkers).split('\u0000');
  const sections: Section[] = [{ heading: fileHeading || fallback, paras: [] }];
  // parts alternate: content (even), heading marker (odd), content (even)…
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const heading = part.trim();
      if (heading) sections.push({ heading, paras: [] });
      return;
    }
    sections[sections.length - 1].paras.push(
      ...part
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\s+/g, ' ').trim())
        .filter((p) => p),
    );
  });
  return sections;
}

function plainSections(text: string, fallback: string): Section[] {
  const paras = text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter((p) => p);
  return [{ heading: fallback, paras }];
}

/** hard-split an oversized paragraph on word boundaries (~TARGET_CHARS each) */
function splitBig(p: string): string[] {
  const out: string[] = [];
  let rest = p;
  while (rest.length > TARGET_CHARS * 1.5) {
    let cut = rest.lastIndexOf(' ', TARGET_CHARS);
    if (cut < TARGET_CHARS / 2) cut = TARGET_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

function pushChunks(out: Chunk[], relPath: string, heading: string, paras: string[]): void {
  let buf: string[] = [];
  let size = 0;
  const flush = () => {
    const text = buf.join('\n\n').trim();
    if (text) out.push({ id: chunkId(relPath, text), relPath, title: header(relPath, heading), text });
    buf = [];
    size = 0;
  };
  for (const p of paras) {
    if (p.length > TARGET_CHARS * 1.5) {
      flush();
      for (const piece of splitBig(p)) {
        out.push({ id: chunkId(relPath, piece), relPath, title: header(relPath, heading), text: piece });
      }
      continue;
    }
    if (size + p.length > TARGET_CHARS && buf.length > 0) flush();
    buf.push(p);
    size += p.length;
  }
  flush();
}

export function fileKind(ext: string): 'md' | 'html' | 'plain' | null {
  if (ext === '.md') return 'md';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (TEXT_EXT.has(ext)) return 'plain';
  return null;
}

/** every file under material/ (recursively), as basename(lower) → relPath — includes PDFs: graph nodes attribute to them */
export async function materialFileMap(subjectPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(subjectPath, rel);
      if (e.isDirectory()) {
        if (e.name === 'graphify-out') continue; // pipeline cache inside material/ is not course material
        await walk(abs, rel);
      } else if (e.isFile()) {
        if (!map.has(e.name.toLowerCase())) map.set(e.name.toLowerCase(), rel);
      }
    }
  };
  await walk(path.join(subjectPath, 'material'), 'material');
  return map;
}

/** the text-extractable sources, in chunk read order: material/**, graphify-out/wiki/*.md, lessons/*.html */
export async function textSourceFiles(subjectPath: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const materialMap = await materialFileMap(subjectPath);
  for (const relPath of materialMap.values()) {
    const kind = fileKind(path.extname(relPath).toLowerCase());
    if (kind) files.push({ relPath, abs: path.join(subjectPath, relPath), kind });
  }
  const list = async (dir: string, exts: string[]) => {
    let entries;
    try {
      entries = await readdir(path.join(subjectPath, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      if (!exts.includes(path.extname(e.name).toLowerCase())) continue;
      const relPath = `${dir}/${e.name}`;
      files.push({ relPath, abs: path.join(subjectPath, relPath), kind: exts[0] === '.md' ? 'md' : 'html' });
    }
  };
  await list('graphify-out/wiki', ['.md']);
  await list('lessons', ['.html']);
  return files;
}

/** chunk every source of a subject into ~600-token chunks with contextual headers */
export async function chunkSubject(subjectPath: string): Promise<Chunk[]> {
  const out: Chunk[] = [];
  for (const f of await textSourceFiles(subjectPath)) {
    let raw: string;
    try {
      raw = await readFile(f.abs, 'utf8');
    } catch {
      continue; // unreadable source — skip, the rest still indexes
    }
    const fallback = path.basename(f.relPath);
    const sections =
      f.kind === 'md' ? markdownSections(raw) : f.kind === 'html' ? htmlSections(raw, fallback) : plainSections(raw, fallback);
    for (const s of sections) pushChunks(out, f.relPath, s.heading || fallback, s.paras);
  }

  // graph nodes: one chunk each, attributed to their primary source file
  const materialMap = await materialFileMap(subjectPath);
  let graph: { nodes?: { label?: unknown; description?: unknown; source_file?: unknown }[] };
  try {
    graph = JSON.parse(await readFile(path.join(subjectPath, 'graphify-out', 'graph.json'), 'utf8'));
  } catch {
    graph = {};
  }
  for (const node of graph.nodes ?? []) {
    const label = typeof node.label === 'string' ? node.label : '';
    const description = typeof node.description === 'string' ? node.description : '';
    const text = description ? `${label}\n\n${description}` : label;
    if (!text.trim()) continue;
    const src = typeof node.source_file === 'string' ? node.source_file.toLowerCase() : '';
    const relPath = (src && materialMap.get(src)) || 'graphify-out/graph.json';
    out.push({ id: chunkId(relPath, text), relPath, title: header(relPath, label), text });
  }
  return out;
}

/** max mtime across all chunk sources (material/**, wiki, lessons, graph.json), ISO — null when nothing exists */
export async function maxSourceMtime(subjectPath: string): Promise<string | null> {
  const { stat } = await import('node:fs/promises');
  let max: string | null = null;
  const seen = async (abs: string): Promise<void> => {
    try {
      const m = (await stat(abs)).mtime.toISOString();
      if (max === null || m > max) max = m;
    } catch {
      // vanished between walk and stat — ignore
    }
  };
  for (const rel of await materialFileMap(subjectPath).then((m) => [...m.values()])) {
    await seen(path.join(subjectPath, rel));
  }
  for (const f of await textSourceFiles(subjectPath)) await seen(f.abs);
  await seen(path.join(subjectPath, 'graphify-out', 'graph.json'));
  return max;
}
