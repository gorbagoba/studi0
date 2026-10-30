import type { Db } from '../index.js';
import type { Job } from '@studi0/shared';

export interface JobRow {
  id: string;
  subject_id: string;
  kind: Job['kind'];
  status: Job['status'];
  progress_done: number;
  progress_total: number;
  current_file: string | null;
  partial_json: string | null;
  error: string | null;
  pid: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const ACTIVE: Job['status'][] = ['queued', 'running', 'cancelling'];

export function jobToDto(row: JobRow): Job {
  return {
    id: row.id,
    subjectId: row.subject_id,
    kind: row.kind,
    status: row.status,
    progress: {
      done: row.progress_done,
      total: row.progress_total,
      currentFile: row.current_file,
    },
    partial: row.partial_json ? (JSON.parse(row.partial_json) as Job['partial']) : null,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function insertJob(db: Db, id: string, subjectId: string, kind: Job['kind']): JobRow {
  db.prepare(
    'INSERT INTO jobs (id, subject_id, kind, status, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, subjectId, kind, 'queued', new Date().toISOString());
  return getJob(db, id) as JobRow;
}

export function getJob(db: Db, id: string): JobRow | null {
  return (db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) ?? null) as unknown as JobRow | null;
}

export function activeJobForSubject(db: Db, subjectId: string): JobRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM jobs WHERE subject_id = ? AND status IN ('queued','running','cancelling')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(subjectId) ?? null) as unknown as JobRow | null
  );
}

export function listJobs(
  db: Db,
  filter: { subjectId?: string; activeOnly?: boolean },
): JobRow[] {
  const conds: string[] = [];
  const args: string[] = [];
  if (filter.subjectId) {
    conds.push('subject_id = ?');
    args.push(filter.subjectId);
  }
  if (filter.activeOnly) {
    conds.push(`status IN (${ACTIVE.map(() => '?').join(',')})`);
    args.push(...ACTIVE);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC`)
    .all(...args) as unknown as JobRow[];
}

export interface JobPatch {
  status?: Job['status'];
  progress_done?: number;
  progress_total?: number;
  current_file?: string | null;
  partial_json?: string | null;
  error?: string | null;
  pid?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

const COLUMNS: Record<keyof JobPatch, string> = {
  status: 'status',
  progress_done: 'progress_done',
  progress_total: 'progress_total',
  current_file: 'current_file',
  partial_json: 'partial_json',
  error: 'error',
  pid: 'pid',
  started_at: 'started_at',
  finished_at: 'finished_at',
};

export function updateJob(db: Db, id: string, patch: JobPatch): JobRow | null {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [k, col] of Object.entries(COLUMNS) as [keyof JobPatch, string][]) {
    const v = patch[k];
    if (v === undefined) continue;
    sets.push(`${col} = ?`);
    args.push(v);
  }
  if (sets.length) {
    args.push(id);
    db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }
  return getJob(db, id);
}

/** Boot cleanup: jobs left running/cancelling by a server restart are closed as failed. */
export function closeStaleRunning(db: Db): number {
  const res = db
    .prepare(
      `UPDATE jobs SET status = 'failed', error = ?, finished_at = ?
       WHERE status IN ('running','cancelling')`,
    )
    .run('server restarted', new Date().toISOString());
  return Number(res.changes);
}
