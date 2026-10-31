import path from 'node:path';
import { parseFailures, parseProgress, type FailureLine } from './parse.js';
import { killTree, killTreeWithDeadline, spawnArgs } from '../util/proc.js';
import { extractionPrompt, VERIFICATION_PROMPT } from '../graph/prompts.js';
import { safeWriteFile } from '../fs/safeWrite.js';
import * as jobsRepo from '../db/repos/jobs.js';
import type { Db } from '../db/index.js';
import type { JobRow } from '../db/repos/jobs.js';
import type { SubjectRow } from '../db/repos/subjects.js';
import type { OneshotFn } from '../util/oneshot.js';

export interface PipelineUpdate {
  done: number;
  total: number;
  currentFile: string | null;
}

export interface PipelineOutcome {
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  partial: FailureLine[] | null;
  error: string | null;
}

export type RunPipelineFn = (
  job: JobRow,
  subject: SubjectRow,
  onUpdate: (u: PipelineUpdate) => void,
  signal: AbortSignal,
) => Promise<PipelineOutcome>;

/** Per-job kill registry — the queue's cancel path calls through it. */
const kills = new Map<string, () => void>();

export function killJob(jobId: string): void {
  kills.get(jobId)?.();
}

/**
 * The real pipeline job body: headless `opencode run` in the subject dir
 * (graphify build/update/re-cluster), progress protocol parsing, then the
 * verification pass as a second headless run writing VERIFY_REPORT.md.
 */
export const makeRunPipeline =
  (oneshot: OneshotFn, db: Db): RunPipelineFn =>
  async (job, subject, onUpdate, signal) => {
    const prompt = extractionPrompt(job.kind, subject.name);
    // --agent: the global default agent is plan-only and would never execute
    // graphify; --standalone: a private opencode server inside this tree so
    // kill-tree can stop (and observe) the actual agent work
    const { pid, done, child } = spawnArgs(
      ['run', '--auto', '--agent', 'studi0-pipeline', '--standalone', prompt],
      subject.path,
    );
    // persist the pid: boot cleanup must be able to kill-tree orphans after a restart
    jobsRepo.updateJob(db, job.id, { pid: pid !== undefined ? String(pid) : null });
    let aborted = false;
    const abort = () => {
      aborted = true;
      if (pid !== undefined) killTreeWithDeadline(pid);
      else child.kill();
    };
    kills.set(job.id, abort);
    signal.addEventListener('abort', abort, { once: true });

    let tail = '';
    const handleLine = (line: string) => {
      const p = parseProgress(line);
      if (p) onUpdate({ done: p.done, total: p.total, currentFile: p.file });
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      tail += chunk;
      let idx: number;
      while ((idx = tail.indexOf('\n')) >= 0) {
        handleLine(tail.slice(0, idx));
        tail = tail.slice(idx + 1);
      }
    });

    try {
      const res = await done;
      handleLine(tail); // flush trailing line
      if (aborted || signal.aborted) {
        return { status: 'cancelled', partial: parseFailures(res.stdout), error: null };
      }
      if (res.code !== 0) {
        // stderr tail stays in server logs — the job row (client-visible) gets a generic message
        const stderrTail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
        console.error(`[job ${job.id}] opencode run exited ${res.code}: ${stderrTail || 'no stderr'}`);
        return {
          status: 'failed',
          partial: parseFailures(res.stdout),
          error: `opencode run exited with code ${res.code}`,
        };
      }
      const failures = parseFailures(res.stdout);
      let status: PipelineOutcome['status'] = failures.length ? 'partial' : 'complete';
      let partial: FailureLine[] | null = failures.length ? failures : null;
      // verification pass (second headless run); failure downgrades to partial
      try {
        const report = await oneshot(subject.path, VERIFICATION_PROMPT, signal);
        await safeWriteFile(
          path.join(subject.path, 'graphify-out', 'VERIFY_REPORT.md'),
          report.trim() + '\n',
        );
      } catch {
        if (aborted || signal.aborted) return { status: 'cancelled', partial, error: null };
        if (status === 'complete') status = 'partial';
        partial = [
          ...(partial ?? []),
          { file: '(verification)', reason: 'verification failed; edges unverified' },
        ];
      }
      return { status, partial, error: null };
    } finally {
      kills.delete(job.id);
      signal.removeEventListener('abort', abort);
      // the direct child is gone; reap any descendants it outlived (best-effort)
      if (pid !== undefined) void killTree(pid);
    }
  };
