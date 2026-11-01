import type { JobStatus } from '@studi0/shared';

// leaf module so SubjectPage can stay light while JobPanel itself is lazy-loaded
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'complete',
  'partial',
  'failed',
  'cancelled',
]);
