import type { Job, JobStatus } from '@studi0/shared';

// leaf module so SubjectPage can stay light while JobPanel itself is lazy-loaded
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'complete',
  'partial',
  'failed',
  'cancelled',
]);

// lifecycle order — a snapshot must never move backwards through it
export const JOB_STATUS_RANK: Record<JobStatus, number> = {
  queued: 0,
  running: 1,
  cancelling: 2,
  complete: 3,
  partial: 3,
  failed: 3,
  cancelled: 3,
};

/**
 * Picks the snapshot further along the lifecycle (QA #7): a late/duplicate
 * frame must never regress a live job back to "Queued…". Different job ids
 * and equal ranks (a re-emit of the same terminal state) take the newcomer.
 */
export function keepNewerJob(cur: Job, next: Job): Job {
  return cur.id === next.id && JOB_STATUS_RANK[cur.status] > JOB_STATUS_RANK[next.status]
    ? cur
    : next;
}
