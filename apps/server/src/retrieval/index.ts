import type { Db } from '../db/index.js';
import type { SubjectRow } from '../db/repos/subjects.js';
import { chunkSubject, maxSourceMtime } from './chunk.js';
import { embedTexts } from './embed.js';

const inflight = new Map<string, Promise<void>>(); // subject id → running build (single-user app: per-process guard)
const tablesReady = new WeakSet<object>();

/** r_* tables are retrieval-owned — created lazily, never in migrations, so the rest of the app never sees them */
export function ensureTables(db: Db): void {
  if (tablesReady.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS r_chunks (
      subject_id TEXT NOT NULL,
      id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (subject_id, id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS r_fts USING fts5(
      subject_id UNINDEXED, chunk_id UNINDEXED, title, text
    );
    CREATE TABLE IF NOT EXISTS r_vectors (
      subject_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      vec BLOB NOT NULL,
      PRIMARY KEY (subject_id, chunk_id)
    );
    CREATE TABLE IF NOT EXISTS r_index_meta (
      subject_id TEXT PRIMARY KEY,
      built_at TEXT NOT NULL,
      source_mtime TEXT NOT NULL
    );
  `);
  tablesReady.add(db);
}

/**
 * Chunk → FTS → embed → vectors, then stamp freshness. Embedding failure is
 * non-fatal: the index stays FTS-only (search falls back further if needed).
 */
export async function buildRetrievalIndex(
  db: Db,
  subjectId: string,
  subjectPath: string,
  opts: { log?: (msg: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? ((msg: string) => console.log(`[retrieval ${subjectId.slice(0, 8)}] ${msg}`));
  ensureTables(db);
  const chunks = await chunkSubject(subjectPath);
  const sourceMtime = (await maxSourceMtime(subjectPath)) ?? new Date().toISOString();

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM r_fts WHERE subject_id = ?').run(subjectId);
    db.prepare('DELETE FROM r_chunks WHERE subject_id = ?').run(subjectId);
    db.prepare('DELETE FROM r_vectors WHERE subject_id = ?').run(subjectId);
    const insChunk = db.prepare(
      'INSERT INTO r_chunks (subject_id, id, rel_path, title, text) VALUES (?, ?, ?, ?, ?)',
    );
    const insFts = db.prepare('INSERT INTO r_fts (subject_id, chunk_id, title, text) VALUES (?, ?, ?, ?)');
    for (const c of chunks) {
      insChunk.run(subjectId, c.id, c.relPath, c.title, c.text);
      insFts.run(subjectId, c.id, c.title, c.text);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  let vectors = 0;
  try {
    const embeddings = await embedTexts(chunks.map((c) => `${c.title}\n${c.text}`));
    db.exec('BEGIN');
    try {
      const insVec = db.prepare('INSERT INTO r_vectors (subject_id, chunk_id, vec) VALUES (?, ?, ?)');
      chunks.forEach((c, i) => {
        insVec.run(subjectId, c.id, Buffer.from(embeddings[i].buffer));
        vectors++;
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } catch (e) {
    log(`embedding unavailable — index is FTS-only (${e instanceof Error ? e.message : e})`);
  }

  db.prepare(
    `INSERT INTO r_index_meta (subject_id, built_at, source_mtime) VALUES (?, ?, ?)
     ON CONFLICT(subject_id) DO UPDATE SET built_at = excluded.built_at, source_mtime = excluded.source_mtime`,
  ).run(subjectId, new Date().toISOString(), sourceMtime);
  log(`indexed ${chunks.length} chunks (${vectors} vectors)`);
}

/**
 * Build the index when missing or stale (any source mtime newer than built_at).
 * Joins an in-flight build instead of duplicating it.
 */
export async function ensureIndex(
  db: Db,
  subject: Pick<SubjectRow, 'id' | 'path'>,
  opts: { log?: (msg: string) => void } = {},
): Promise<void> {
  const existing = inflight.get(subject.id);
  if (existing) return existing;
  const job = (async () => {
    ensureTables(db);
    const meta = db.prepare('SELECT built_at FROM r_index_meta WHERE subject_id = ?').get(subject.id) as
      | { built_at: string }
      | undefined;
    if (meta) {
      const mtime = await maxSourceMtime(subject.path);
      if (mtime === null || mtime <= meta.built_at) return; // fresh
    }
    await buildRetrievalIndex(db, subject.id, subject.path, opts);
  })().finally(() => inflight.delete(subject.id));
  inflight.set(subject.id, job);
  return job;
}
