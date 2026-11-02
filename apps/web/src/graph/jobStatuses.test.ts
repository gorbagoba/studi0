import { describe, expect, it } from 'vitest';
import type { Job } from '@studi0/shared';
import { JOB_STATUS_RANK, TERMINAL_JOB_STATUSES, keepNewerJob } from './jobStatuses';

const NOW = '2026-11-01T00:00:00.000Z';
function job(status: Job['status'], id = 'j1'): Job {
  return {
    id,
    subjectId: 's1',
    kind: 'build',
    status,
    progress: { done: 0, total: 0, currentFile: null },
    partial: null,
    error: null,
    createdAt: NOW,
    startedAt: null,
    finishedAt: null,
  };
}

describe('keepNewerJob (QA #7: status never regresses)', () => {
  it('keeps the more advanced snapshot when a late queued frame arrives', () => {
    expect(keepNewerJob(job('running'), job('queued')).status).toBe('running');
    expect(keepNewerJob(job('cancelling'), job('running')).status).toBe('cancelling');
    expect(keepNewerJob(job('complete'), job('running')).status).toBe('complete');
  });

  it('takes the newcomer when it is further along, a different job, or the same rank', () => {
    expect(keepNewerJob(job('queued'), job('running')).status).toBe('running');
    expect(keepNewerJob(job('running'), job('cancelling')).status).toBe('cancelling');
    // different job id — the fresh snapshot wins outright
    expect(keepNewerJob(job('running'), job('queued', 'j2')).id).toBe('j2');
    // equal ranks (terminal re-emits) take the newer frame
    expect(keepNewerJob(job('complete'), job('partial')).status).toBe('partial');
  });

  it('ranks every terminal status above cancelling, which is above running', () => {
    for (const t of TERMINAL_JOB_STATUSES) {
      expect(JOB_STATUS_RANK[t]).toBeGreaterThan(JOB_STATUS_RANK.cancelling);
    }
    expect(JOB_STATUS_RANK.cancelling).toBeGreaterThan(JOB_STATUS_RANK.running);
    expect(JOB_STATUS_RANK.running).toBeGreaterThan(JOB_STATUS_RANK.queued);
  });
});
