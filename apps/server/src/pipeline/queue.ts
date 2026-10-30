import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import * as jobsRepo from '../db/repos/jobs.js';
import * as subjectsRepo from '../db/repos/subjects.js';
import type { EventBus } from '../http/sse.js';
import { killJob, type PipelineUpdate, type RunPipelineFn } from './runner.js';
import { HttpError } from '../util/errors.js';
import type { Config } from '../config.js';
import type { Job, JobKind } from '@studi0/shared';

const CANCEL_DEADLINE_MS = 5000; // AC4: job must reach a terminal state within 5s

/**
 * In-process FIFO queue: 1 active job per subject, max N concurrent across
 * subjects. Owns the full job lifecycle row and emits every transition to the
 * subject SSE stream.
 */
export class JobQueue {
  private running = new Set<string>();
  private pending: string[] = [];
  private controllers = new Map<string, AbortController>();
  private runPipeline: RunPipelineFn;

  constructor(
    private db: Db,
    private events: EventBus,
    private cfg: Config,
    runPipeline: RunPipelineFn,
  ) {
    this.runPipeline = runPipeline;
  }

  setRunPipeline(fn: RunPipelineFn): void {
    this.runPipeline = fn;
  }

  private emitJob(row: jobsRepo.JobRow): void {
    this.events.emit(row.subject_id, 'job', jobsRepo.jobToDto(row));
  }

  enqueue(subjectId: string, kind: JobKind): Job {
    const subject = subjectsRepo.getSubject(this.db, subjectId);
    if (!subject) throw new HttpError('SUBJECT_NOT_FOUND', `subject ${subjectId} not found`);
    const active = jobsRepo.activeJobForSubject(this.db, subjectId);
    if (active) {
      throw new HttpError('JOB_CONFLICT', `subject already has an active ${active.kind} job`);
    }
    const row = jobsRepo.insertJob(this.db, randomUUID(), subjectId, kind);
    this.emitJob(row);
    this.pending.push(row.id);
    this.pump();
    return jobsRepo.jobToDto(row);
  }

  private pump(): void {
    while (this.running.size < this.cfg.maxConcurrentJobs && this.pending.length > 0) {
      const jobId = this.pending.shift() as string;
      this.running.add(jobId);
      void this.run(jobId);
    }
  }

  private async run(jobId: string): Promise<void> {
    let row = jobsRepo.getJob(this.db, jobId);
    if (!row) {
      this.running.delete(jobId);
      return;
    }
    const subject = subjectsRepo.getSubject(this.db, row.subject_id);
    if (!subject) {
      row = jobsRepo.updateJob(this.db, jobId, {
        status: 'failed',
        error: 'subject vanished',
        finished_at: new Date().toISOString(),
      }) as jobsRepo.JobRow;
      this.emitJob(row);
      this.running.delete(jobId);
      this.pump();
      return;
    }
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    row = jobsRepo.updateJob(this.db, jobId, {
      status: 'running',
      started_at: new Date().toISOString(),
    }) as jobsRepo.JobRow;
    this.emitJob(row);

    try {
      const outcome = await this.runPipeline(row, subject, (u: PipelineUpdate) => {
        const updated = jobsRepo.updateJob(this.db, jobId, {
          progress_done: u.done,
          progress_total: u.total,
          current_file: u.currentFile,
        });
        if (updated) this.emitJob(updated);
      }, controller.signal);
      // reject terminal states that arrived after a cancel request
      const finalStatus =
        controller.signal.aborted && (outcome.status === 'complete' || outcome.status === 'partial')
          ? 'cancelled'
          : outcome.status;
      row = jobsRepo.updateJob(this.db, jobId, {
        status: finalStatus,
        partial_json: outcome.partial ? JSON.stringify(outcome.partial) : null,
        error: outcome.error,
        pid: null,
        finished_at: new Date().toISOString(),
      }) as jobsRepo.JobRow;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      row = jobsRepo.updateJob(this.db, jobId, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        error: controller.signal.aborted ? null : msg,
        pid: null,
        finished_at: new Date().toISOString(),
      }) as jobsRepo.JobRow;
    } finally {
      this.controllers.delete(jobId);
      if (row && (row.status === 'complete' || row.status === 'partial')) {
        subjectsRepo.setLastBuilt(this.db, row.subject_id, new Date().toISOString());
      }
      if (row) this.emitJob(row);
      this.running.delete(jobId);
      this.pump();
    }
  }

  /** SIGINT path: abort every live job so the runners' abort listeners kill their child trees. */
  drain(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  cancel(jobId: string): Job {
    const row = jobsRepo.getJob(this.db, jobId);
    if (!row) throw new HttpError('JOB_NOT_FOUND', `job ${jobId} not found`);
    if (!['queued', 'running', 'cancelling'].includes(row.status)) {
      throw new HttpError('JOB_NOT_CANCELLABLE', `job is already ${row.status}`);
    }
    if (row.status === 'queued') {
      this.pending = this.pending.filter((id) => id !== jobId);
      const updated = jobsRepo.updateJob(this.db, jobId, {
        status: 'cancelled',
        finished_at: new Date().toISOString(),
      }) as jobsRepo.JobRow;
      this.emitJob(updated);
      return jobsRepo.jobToDto(updated);
    }
    if (row.status === 'running') {
      const updated = jobsRepo.updateJob(this.db, jobId, { status: 'cancelling' });
      if (updated) this.emitJob(updated);
      killJob(jobId);
      const controller = this.controllers.get(jobId);
      controller?.abort();
      // AC4 belt-and-braces: force the terminal state if the child ignores death
      const timer = setTimeout(() => {
        try {
          const current = jobsRepo.getJob(this.db, jobId);
          if (current && ['running', 'cancelling'].includes(current.status)) {
            const forced = jobsRepo.updateJob(this.db, jobId, {
              status: 'cancelled',
              finished_at: new Date().toISOString(),
            });
            if (forced) this.emitJob(forced);
          }
        } catch {
          // app shut down before the deadline — nothing to finalize
        }
      }, CANCEL_DEADLINE_MS);
      timer.unref();
      return jobsRepo.jobToDto(updated as jobsRepo.JobRow);
    }
    // already cancelling — return current row
    return jobsRepo.jobToDto(row);
  }
}
