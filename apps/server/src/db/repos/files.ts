import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';

export interface FileRow {
  id: string;
  subject_id: string;
  rel_path: string;
  bytes: number;
  mtime: string;
  origin: 'upload' | 'seed';
}

export function upsertFile(
  db: Db,
  f: Omit<FileRow, 'id'>,
): FileRow {
  const existing = db
    .prepare('SELECT * FROM files WHERE subject_id = ? AND rel_path = ?')
    .get(f.subject_id, f.rel_path) as unknown as FileRow | undefined;
  if (existing) {
    db.prepare('UPDATE files SET bytes = ?, mtime = ?, origin = ? WHERE id = ?').run(
      f.bytes,
      f.mtime,
      f.origin,
      existing.id,
    );
    return { ...existing, bytes: f.bytes, mtime: f.mtime, origin: f.origin };
  }
  const id = randomUUID();
  db.prepare(
    'INSERT INTO files (id, subject_id, rel_path, bytes, mtime, origin) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, f.subject_id, f.rel_path, f.bytes, f.mtime, f.origin);
  return { id, ...f };
}

export function listFiles(db: Db, subjectId: string): FileRow[] {
  return db.prepare('SELECT * FROM files WHERE subject_id = ?').all(subjectId) as unknown as FileRow[];
}
