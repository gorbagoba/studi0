import path from 'node:path';
import { existsSync } from 'node:fs';
import { extractJson, parseFailures, parseProgress, stripStepMarkers, type FailureLine, type ProgressLine } from './parse.js';
import { appendBuildLog, formatLogLine } from './buildLog.js';
import { killTree, killTreeWithDeadline, spawnArgs, type ChildRun } from '../util/proc.js';
import {
  chunkWavePrompt,
  extractionPrompt,
  mergePrompt,
  planPrompt,
  VERIFICATION_PROMPT,
} from '../graph/prompts.js';
import { safeResolve } from '../fs/paths.js';
import { safeWriteFile } from '../fs/safeWrite.js';
import * as jobsRepo from '../db/repos/jobs.js';
import type { Db } from '../db/index.js';
import type { EventBus } from '../http/sse.js';
import type { JobRow } from '../db/repos/jobs.js';
import type { SubjectRow } from '../db/repos/subjects.js';
import { makeOneshot } from '../util/oneshot.js';
import type { Config } from '../config.js';

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
 * The pipeline job body. build/update run as waves: a planner one-shot decides
 * the chunk split (JSON only), the runner itself executes chunk extractions in
 * waves of ≤ cfg.maxChunkConcurrency headless children (see pnpm calibrate),
 * then a final run merges + exports (plus the verification one-shot).
 * recluster — and any wave run whose plan is unusable — falls back to the
 * original single-run pipeline.
 */
export const makeRunPipeline =
  (db: Db, cfg: Config, events?: EventBus): RunPipelineFn =>
  async (job, subject, onUpdate, signal) => {
    // verification is a few calls — it can afford the thinking model
    const verifyOneshot = makeOneshot(cfg, { model: cfg.graphVerifyModel });
    const startedAt = Date.now();
    // every protocol/raw line lands in build.log AND the subject SSE stream (same text)
    const log = (message: string) => {
      const rel = (Date.now() - startedAt) / 1000;
      void appendBuildLog(subject.path, rel, message);
      events?.emit(subject.id, 'log', {
        line: formatLogLine(rel, message),
        at: new Date().toISOString(),
      });
    };

    let aborted = false;
    const liveKills = new Set<() => void>();
    const spawnedPids = new Set<number>();

    const spawnChild = (args: string[]): ChildRun => {
      // --agent: the global default agent is plan-only and would never execute
      // graphify; --standalone: a private opencode server inside this tree so
      // kill-tree can stop (and observe) the actual agent work
      const { pid, done, child } = spawnArgs(args, subject.path);
      const kill = () => {
        if (pid !== undefined) killTreeWithDeadline(pid);
        else child.kill();
      };
      liveKills.add(kill);
      if (aborted) kill(); // abort raced the spawn — the late child dies immediately
      if (pid !== undefined) {
        spawnedPids.add(pid);
        // persist every spawned pid: boot cleanup kill-trees the whole list after a restart
        jobsRepo.updateJob(db, job.id, { pid: [...spawnedPids].join(',') });
      }
      void done.finally(() => liveKills.delete(kill));
      return { pid, done, child };
    };

    const abort = () => {
      aborted = true;
      for (const kill of [...liveKills]) kill();
    };
    kills.set(job.id, abort);
    signal.addEventListener('abort', abort, { once: true });

    /** Stream child stdout line-by-line; returns a flush for the trailing line. */
    const pipeLines = (child: ChildRun, onLine: (line: string) => void): (() => void) => {
      let tail = '';
      child.child.stdout?.setEncoding('utf8');
      child.child.stdout?.on('data', (chunk: string) => {
        tail += chunk;
        let idx: number;
        while ((idx = tail.indexOf('\n')) >= 0) {
          onLine(tail.slice(0, idx));
          tail = tail.slice(idx + 1);
        }
      });
      return () => onLine(tail);
    };

    const handleLine = (onProgress?: (p: ProgressLine) => void) => (raw: string) => {
      const line = stripStepMarkers(raw);
      const p = parseProgress(line);
      if (p) {
        if (onProgress) onProgress(p);
        else log(`progress: ${p.file ?? '…'} (${p.done}/${p.total})`);
      } else if (line.trim()) {
        log(`out: ${line.trim().slice(0, 160)}`);
      }
    };

    const finish = (outcome: PipelineOutcome): PipelineOutcome => {
      log(`${job.kind} finished: ${outcome.status}${outcome.error ? ` — ${outcome.error}` : ''}`);
      return outcome;
    };

    const runVerification = async (
      status: PipelineOutcome['status'],
      partial: FailureLine[] | null,
    ): Promise<PipelineOutcome> => {
      log('verification pass started');
      try {
        const report = await verifyOneshot(subject.path, VERIFICATION_PROMPT, signal);
        await safeWriteFile(
          path.join(subject.path, 'graphify-out', 'VERIFY_REPORT.md'),
          report.trim() + '\n',
        );
        log('verification report written');
        return { status, partial, error: null };
      } catch {
        if (aborted || signal.aborted) return { status: 'cancelled', partial, error: null };
        log('verification failed — edges unverified');
        return {
          status: status === 'complete' ? 'partial' : status,
          partial: [
            ...(partial ?? []),
            { file: '(verification)', reason: 'verification failed; edges unverified' },
          ],
          error: null,
        };
      }
    };

    /** Original pipeline shape: one headless run does chunking + extraction + export itself. */
    const runSingle = async (): Promise<PipelineOutcome> => {
      if (aborted || signal.aborted) return finish({ status: 'cancelled', partial: null, error: null });
      const child = spawnChild([
        'run',
        '--auto',
        '--model',
        cfg.graphExtractModel,
        '--agent',
        'studi0-pipeline',
        '--standalone',
        extractionPrompt(job.kind, subject.name),
      ]);
      log(`${job.kind} started (job ${job.id.slice(0, 8)})`);
      const flush = pipeLines(
        child,
        handleLine((p) => {
          onUpdate({ done: p.done, total: p.total, currentFile: p.file });
          log(`progress: ${p.file ?? '…'} (${p.done}/${p.total})`);
        }),
      );
      const res = await child.done;
      flush(); // trailing line
      if (aborted || signal.aborted) {
        return finish({ status: 'cancelled', partial: parseFailures(res.stdout), error: null });
      }
      if (res.code !== 0) {
        // stderr tail stays in server logs — the job row (client-visible) gets a generic message
        const stderrTail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
        console.error(`[job ${job.id}] opencode run exited ${res.code}: ${stderrTail || 'no stderr'}`);
        return finish({
          status: 'failed',
          partial: parseFailures(res.stdout),
          error: `opencode run exited with code ${res.code}`,
        });
      }
      // exit 0 is not success: a run that ends its turn mid-pipeline produces no graph
      if (!existsSync(path.join(subject.path, 'graphify-out', 'graph.json'))) {
        log('FAILED: run ended without producing graph.json (extraction incomplete? see out: lines above)');
        return finish({
          status: 'failed',
          partial: parseFailures(res.stdout),
          error: 'pipeline run ended without producing graph.json (see build log)',
        });
      }
      const failures = parseFailures(res.stdout);
      for (const f of failures) log(`failed file: ${f.file} — ${f.reason}`);
      const status: PipelineOutcome['status'] = failures.length ? 'partial' : 'complete';
      return finish(await runVerification(status, failures.length ? failures : null));
    };

    /** Strict-parse the planner's answer: JSON list of chunk prompt file paths (+ total, the list wins).
     * Confined to the declared shape (graphify-out/chunks/<single-segment>.md) and capped — the planner's
     * output is model text crossing into path selection and prompt construction (LLM05/LLM01):
     * a confused/hijacked planner must degrade to the safe single-run fallback, never fan out. */
    const parsePlan = (stdout: string): string[] | null => {
      const parsed = extractJson(stdout) as { chunks?: unknown } | unknown[] | null;
      const list = Array.isArray(parsed) ? parsed : parsed?.chunks;
      const MAX_CHUNKS = 64;
      if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CHUNKS) return null;
      const chunks: string[] = [];
      for (const item of list) {
        if (typeof item !== 'string' || !/^graphify-out\/chunks\/[A-Za-z0-9._-]+\.md$/.test(item)) {
          return null;
        }
        try {
          if (!existsSync(safeResolve(subject.path, item))) return null; // planner must have written every chunk file
        } catch {
          return null; // traversal or bad path → unusable plan
        }
        chunks.push(item);
      }
      return chunks;
    };

    const runWaves = async (): Promise<PipelineOutcome> => {
      log(`${job.kind} started (job ${job.id.slice(0, 8)})`);
      log('planning chunk split');
      // stage 1 — planner one-shot: chunks ONLY, no extraction
      // (runWaves is only reached for build/update — recluster dispatches to runSingle)
      const planChild = spawnChild([
        'run',
        '--auto',
        '--model',
        cfg.graphPlanModel,
        '--agent',
        'studi0-pipeline',
        '--standalone',
        planPrompt(job.kind as 'build' | 'update', subject.name),
      ]);
      const planFlush = pipeLines(planChild, handleLine());
      const planRes = await planChild.done;
      planFlush();
      if (aborted || signal.aborted) return finish({ status: 'cancelled', partial: null, error: null });
      const chunks = planRes.code === 0 ? parsePlan(planRes.stdout) : null;
      if (!chunks) {
        // planner misbehaved — the single-run pipeline is safe (subject-local) and keeps the build working
        log('chunk plan unusable — falling back to single-run pipeline');
        return runSingle();
      }
      log(`chunk plan: ${chunks.length} chunks`);
      const total = chunks.length;

      // stage 2 — chunk extraction in waves of ≤ maxChunkConcurrency concurrent children
      const wave = cfg.maxChunkConcurrency;
      let done = 0;
      const failures: FailureLine[] = [];
      const runChunk = async (chunk: string): Promise<FailureLine[]> => {
        const child = spawnChild([
          'run',
          '--auto',
          '--model',
          cfg.graphExtractModel,
          '--agent',
          'studi0-pipeline',
          '--standalone',
          chunkWavePrompt(chunk),
        ]);
        const flush = pipeLines(child, handleLine());
        const res = await child.done;
        flush();
        if (aborted || signal.aborted) return [];
        if (res.code !== 0) {
          const stderrTail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
          console.error(`[job ${job.id}] chunk ${chunk} exited ${res.code}: ${stderrTail || 'no stderr'}`);
          log(`chunk failed: ${chunk}`);
          return [{ file: chunk, reason: `chunk run exited with code ${res.code}` }];
        }
        const chunkFailures = parseFailures(res.stdout);
        for (const f of chunkFailures) log(`failed file: ${f.file} — ${f.reason}`);
        return chunkFailures;
      };
      for (let i = 0; i < chunks.length; i += wave) {
        onUpdate({ done, total, currentFile: chunks[i] });
        // failures accumulate in chunk order — concurrent children must not reorder the report
        const reported = await Promise.all(chunks.slice(i, i + wave).map(runChunk));
        for (const fl of reported) failures.push(...fl);
        done = Math.min(i + wave, total);
        if (aborted || signal.aborted) return finish({ status: 'cancelled', partial: null, error: null });
      }
      onUpdate({ done, total, currentFile: null });

      // stage 3 — merge + export (same tail as the single-run pipeline)
      log('merging chunk outputs');
      const mergeChild = spawnChild([
        'run',
        '--auto',
        '--model',
        cfg.graphMergeModel,
        '--agent',
        'studi0-pipeline',
        '--standalone',
        mergePrompt(subject.name),
      ]);
      const mergeFlush = pipeLines(mergeChild, handleLine());
      const mergeRes = await mergeChild.done;
      mergeFlush();
      if (aborted || signal.aborted) return finish({ status: 'cancelled', partial: null, error: null });
      if (mergeRes.code !== 0) {
        const stderrTail = mergeRes.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
        console.error(`[job ${job.id}] merge run exited ${mergeRes.code}: ${stderrTail || 'no stderr'}`);
        return finish({
          status: 'failed',
          partial: failures.length ? failures : null,
          error: `merge run exited with code ${mergeRes.code}`,
        });
      }
      if (!existsSync(path.join(subject.path, 'graphify-out', 'graph.json'))) {
        log('FAILED: run ended without producing graph.json (extraction incomplete? see out: lines above)');
        return finish({
          status: 'failed',
          partial: failures.length ? failures : null,
          error: 'pipeline run ended without producing graph.json (see build log)',
        });
      }
      for (const f of parseFailures(mergeRes.stdout)) {
        failures.push(f);
        log(`failed file: ${f.file} — ${f.reason}`);
      }
      const status: PipelineOutcome['status'] = failures.length ? 'partial' : 'complete';
      return finish(await runVerification(status, failures.length ? failures : null));
    };

    try {
      if (job.kind === 'recluster') return await runSingle(); // re-clusters the existing graph — nothing to chunk
      return await runWaves();
    } finally {
      kills.delete(job.id);
      signal.removeEventListener('abort', abort);
      // the direct children are gone; reap any descendants they outlived (best-effort)
      for (const pid of spawnedPids) void killTree(pid);
    }
  };
