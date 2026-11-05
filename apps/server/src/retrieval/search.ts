import { readFile } from 'node:fs/promises';
import type { Db } from '../db/index.js';
import { textSourceFiles, htmlToText } from './chunk.js';
import { embedTexts } from './embed.js';
import { ensureTables } from './index.js';

export interface RetrievalHit {
  relPath: string;
  title: string;
  snippet: string;
  score: number;
  channels: ('bm25' | 'dense' | 'grep')[];
}

const FTS_LIMIT = 20;
const DENSE_LIMIT = 20;
const RRF_K = 60;
const SNIPPET_CHARS = 400;

interface ChunkRow {
  id: string;
  rel_path: string;
  title: string;
  text: string;
}

/** lowercase word terms (≥3 chars, deduped, capped) — shared by FTS and grep */
function queryTerms(query: string, cap = 12): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((t) => t.length >= 3)
        .slice(0, cap),
    ),
  ];
}

/** FTS5 MATCH query: quote each term, OR-join ('' when no usable terms) */
export function ftsMatchQuery(query: string): string {
  return queryTerms(query)
    .map((t) => `"${t}"`)
    .join(' OR ');
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Hybrid search: FTS5 (BM25) top-20 + dense (cosine over stored vectors) top-20,
 * fused with Reciprocal Rank Fusion (k=60). Falls back to grep when there is no
 * index, and to grep when both channels come up empty. Never throws.
 */
export async function hybridSearch(
  db: Db,
  subjectId: string,
  query: string,
  opts: { k?: number; subjectPath?: string; log?: (msg: string) => void } = {},
): Promise<RetrievalHit[]> {
  const k = opts.k ?? 8;
  ensureTables(db);
  const chunks = db
    .prepare('SELECT id, rel_path, title, text FROM r_chunks WHERE subject_id = ?')
    .all(subjectId) as unknown as ChunkRow[];
  if (chunks.length === 0) {
    return opts.subjectPath ? grepSearch(opts.subjectPath, query, { k }) : [];
  }
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const fused = new Map<string, { score: number; channels: Set<RetrievalHit['channels'][number]> }>();

  try {
    const match = ftsMatchQuery(query);
    if (match) {
      const rows = db
        .prepare(
          'SELECT chunk_id FROM r_fts WHERE r_fts MATCH ? AND subject_id = ? ORDER BY rank LIMIT ?',
        )
        .all(match, subjectId, FTS_LIMIT) as unknown as { chunk_id: string }[];
      rows.forEach((r, i) => {
        const entry = fused.get(r.chunk_id) ?? { score: 0, channels: new Set() };
        entry.score += 1 / (RRF_K + i + 1);
        entry.channels.add('bm25');
        fused.set(r.chunk_id, entry);
      });
    }
  } catch {
    // bm25 unavailable (corrupt/missing FTS) — dense alone still answers
  }

  try {
    const [queryVec] = await embedTexts([query]);
    if (queryVec) {
      const rows = db
        .prepare('SELECT chunk_id, vec FROM r_vectors WHERE subject_id = ?')
        .all(subjectId) as unknown as { chunk_id: string; vec: Buffer }[];
      const scored = rows.map((r) => ({
        id: r.chunk_id,
        cosine: dot(queryVec, new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)),
      }));
      scored.sort((a, b) => b.cosine - a.cosine);
      scored.slice(0, DENSE_LIMIT).forEach((s, i) => {
        const entry = fused.get(s.id) ?? { score: 0, channels: new Set() };
        entry.score += 1 / (RRF_K + i + 1);
        entry.channels.add('dense');
        fused.set(s.id, entry);
      });
    }
  } catch (e) {
    // dense unavailable (embedder down) — bm25 alone still answers
    opts.log?.(`dense channel unavailable — bm25 only (${e instanceof Error ? e.message : e})`);
  }

  const hits = [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, k)
    .map(([id, entry]) => {
      const c = byId.get(id) as ChunkRow;
      return {
        relPath: c.rel_path,
        title: c.title,
        snippet: c.text.slice(0, SNIPPET_CHARS),
        score: entry.score,
        channels: [...entry.channels],
      };
    });
  if (hits.length === 0 && opts.subjectPath) return grepSearch(opts.subjectPath, query, { k });
  return hits;
}

/**
 * Keyword baseline: case-insensitive term search over the same text-extractable
 * files the chunker reads. Files rank by matched distinct-term occurrences.
 */
export async function grepSearch(
  subjectPath: string,
  query: string,
  opts: { k?: number } = {},
): Promise<RetrievalHit[]> {
  const k = opts.k ?? 8;
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const hits: RetrievalHit[] = [];
  for (const f of await textSourceFiles(subjectPath)) {
    let raw: string;
    try {
      raw = await readFile(f.abs, 'utf8');
    } catch {
      continue;
    }
    if (f.kind === 'html') raw = htmlToText(raw);
    let score = 0;
    let bestLine = '';
    let bestLineScore = 0;
    for (const line of raw.split(/\r?\n/)) {
      const lower = line.toLowerCase();
      let distinct = 0;
      for (const t of terms) if (lower.includes(t)) distinct++;
      if (distinct === 0) continue;
      score += distinct;
      if (distinct > bestLineScore) {
        bestLineScore = distinct;
        bestLine = line.trim();
      }
    }
    if (score > 0) {
      hits.push({
        relPath: f.relPath,
        title: f.relPath,
        snippet: bestLine.slice(0, SNIPPET_CHARS),
        score,
        channels: ['grep'],
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, k);
}
