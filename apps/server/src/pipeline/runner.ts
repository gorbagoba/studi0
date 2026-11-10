import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseFailures, parseProgress, stripStepMarkers, type FailureLine, type ProgressLine } from './parse.js';
import { appendBuildLog, formatLogLine } from './buildLog.js';
import { killTree, killTreeWithDeadline, spawnArgs, type ChildRun } from '../util/proc.js';
import { reclusterPrompt, VERIFICATION_PROMPT } from '../graph/prompts.js';
import { listMaterialFiles } from '../graph/plan.js';
import { auditGraph, detectHollowExtraction, mergeDuplicateNodes, ontologyProblems } from '../graph/quality.js';
import { graphAsk, typeGraphFile } from '../graph/typing.js';
import { safeResolve } from '../fs/paths.js';
import { safeWriteFile } from '../fs/safeWrite.js';
import { graphEnv } from '../graph/backendEnv.js';
import { normalizeGraphifyOutput } from '../graph/normalize.js';
import { INSPECT_SCRIPT } from '../graph/inspectScript.js';
import { prepareRebuild } from '../graph/rebuildPrep.js';
import { checkGraphify } from '../graph/preflight.js';
import { runGraphifyExtract } from '../graph/extract.js';
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
 * The pipeline job body. build/update/rebuild run graphify extraction on the
 * SERVER (see runGraphifyExtract — its own 45m timeout, never an agent turn),
 * then the quality gate and the verification one-shot. recluster still asks the
 * agent to run `graphify cluster-only` on the existing graph.
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

    // fail fast on a broken venv — an agent cannot install it and must not try
    const preflight = await checkGraphify(cfg.graphifyBin);
    if (!preflight.ok) {
      log(preflight.error);
      return { status: 'failed', partial: null, error: preflight.error };
    }
    log(`graphify ${preflight.version} (backend ${cfg.graphBackend}, model ${cfg.graphModel || 'default'})`);
    if (job.kind === 'rebuild') log('full rebuild (cache cleared)');

    // zero-shell inspection: the server writes the python the prompts tell the agent to run
    try {
      await safeWriteFile(
        safeResolve(subject.path, 'graphify-out/inspect_graph.py'),
        INSPECT_SCRIPT,
      );
    } catch (e) {
      log(`inspect script write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // rebuild prep is server-owned: back up the graph and clear stale state before any agent runs
    if (job.kind === 'rebuild') {
      try {
        await prepareRebuild(subject.path, log);
      } catch (e) {
        const error = `rebuild prep failed: ${e instanceof Error ? e.message : String(e)}`;
        log(`FAILED: ${error}`);
        return { status: 'failed', partial: null, error };
      }
    }

    let aborted = false;
    const liveKills = new Set<() => void>();
    const spawnedPids = new Set<number>();

    // persist every spawned pid: boot cleanup kill-trees the whole list after a restart
    const registerPid = (pid: number | undefined) => {
      if (pid === undefined) return;
      spawnedPids.add(pid);
      jobsRepo.updateJob(db, job.id, { pid: [...spawnedPids].join(',') });
    };

    const spawnChild = (args: string[]): ChildRun => {
      // --agent: the global default agent is plan-only and would never execute
      // graphify; --standalone: a private opencode server inside this tree so
      // kill-tree can stop (and observe) the actual agent work
      const { pid, done, child } = spawnArgs(args, subject.path, graphEnv(cfg));
      const kill = () => {
        if (pid !== undefined) killTreeWithDeadline(pid);
        else child.kill();
      };
      liveKills.add(kill);
      if (aborted) kill(); // abort raced the spawn — the late child dies immediately
      registerPid(pid);
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

    /**
     * Merge duplicate labels and enforce the fixed ontology before verification.
     * Returns a failed outcome, or null when the graph is acceptable.
     */
    const runQualityGate = async (partial: FailureLine[] | null): Promise<PipelineOutcome | null> => {
      const graphPath = path.join(subject.path, 'graphify-out', 'graph.json');
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(graphPath, 'utf8'));
      } catch (e) {
        const error = `graph.json unreadable: ${e instanceof Error ? e.message : String(e)}`;
        log(`FAILED: ${error}`);
        return { status: 'failed', partial, error };
      }
      const { graph, merged } = mergeDuplicateNodes(parsed);
      if (merged > 0) {
        try {
          await safeWriteFile(graphPath, JSON.stringify(graph, null, 2) + '\n');
          log(`merged ${merged} duplicate nodes`);
        } catch (e) {
          const error = `graph.json write failed: ${e instanceof Error ? e.message : String(e)}`;
          log(`FAILED: ${error}`);
          return { status: 'failed', partial, error };
        }
      }
      // hollow extraction (hollow model responses → one node per file) must fail
      // before typing: typing a fallback graph would only dress up a failed build
      const materialFileCount = (await listMaterialFiles(subject.path).catch(() => [])).length;
      const hollow = detectHollowExtraction(graph, materialFileCount);
      if (hollow) {
        const error = `graph extraction produced no semantic content (${hollow}); graphify returned hollow responses — retry the build (extraction model ${cfg.graphModel || 'qwen3-coder-next'})`;
        log(`FAILED: ${error}`);
        return { status: 'failed', partial, error };
      }
      // ontology typing runs before the gate so graphify's defaults get mapped;
      // a zero/partial result leaves the gate to fail with its precise message
      let assessed = graph;
      if (job.kind !== 'recluster') {
        try {
          const typed = await typeGraphFile(subject.path, graphAsk(cfg, signal), log);
          assessed = typed.graph;
          log(
            `typed ${typed.nodes} nodes, ${typed.edges} edges (graph model ${cfg.chatModel || 'default'})`,
          );
        } catch (e) {
          log(`typing failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const audit = auditGraph(assessed);
      const problems = ontologyProblems(audit);
      log(
        `graph quality: ${audit.nodes} nodes, ${audit.edges} edges, ${audit.orphans} orphans, ${merged} duplicates merged, ${problems.nodeViolations + problems.edgeViolations} ontology violations`,
      );
      if (problems.error) {
        log(`FAILED: ${problems.error}`);
        return { status: 'failed', partial, error: problems.error };
      }
      return null;
    };

    /** build/update/rebuild: the server runs graphify itself, then the shared gate. */
    const runExtract = async (): Promise<PipelineOutcome> => {
      log(`${job.kind} started (job ${job.id.slice(0, 8)})`);
      const res = await runGraphifyExtract({
        cfg,
        subjectPath: subject.path,
        log,
        signal,
        onPid: registerPid,
        // chunk counts come from graphify itself; the per-file name is unknown here
        onProgress: (done, total) => onUpdate({ done, total, currentFile: null }),
      });
      if (aborted || signal.aborted) return finish({ status: 'cancelled', partial: null, error: null });
      if (!res.ok) {
        log(`FAILED: ${res.error}`);
        return finish({ status: 'failed', partial: null, error: res.error });
      }
      // an agent that cd-ed into graphify-out nested the output — flatten it deterministically
      await normalizeGraphifyOutput(subject.path, log);
      const rejected = await runQualityGate(null);
      if (rejected) return finish(rejected);
      return finish(await runVerification('complete', null));
    };

    /** recluster: one headless run re-clusters the existing graph in place. */
    const runRecluster = async (): Promise<PipelineOutcome> => {
      if (aborted || signal.aborted) return finish({ status: 'cancelled', partial: null, error: null });
      const child = spawnChild([
        'run',
        '--auto',
        '--model',
        cfg.graphVerifyModel,
        '--agent',
        'studi0-pipeline',
        '--standalone',
        reclusterPrompt(),
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
      await normalizeGraphifyOutput(subject.path, log);
      // exit 0 is not success: a run that ends its turn mid-pipeline produces no graph
      if (!existsSync(path.join(subject.path, 'graphify-out', 'graph.json'))) {
        log('FAILED: run ended without producing graph.json (recluster incomplete? see out: lines above)');
        return finish({
          status: 'failed',
          partial: parseFailures(res.stdout),
          error: 'recluster run ended without producing graph.json (see build log)',
        });
      }
      const failures = parseFailures(res.stdout);
      for (const f of failures) log(`failed file: ${f.file} — ${f.reason}`);
      const partial = failures.length ? failures : null;
      const rejected = await runQualityGate(partial);
      if (rejected) return finish(rejected);
      const status: PipelineOutcome['status'] = failures.length ? 'partial' : 'complete';
      return finish(await runVerification(status, partial));
    };

    try {
      if (job.kind === 'recluster') return await runRecluster();
      return await runExtract();
    } finally {
      kills.delete(job.id);
      signal.removeEventListener('abort', abort);
      // the direct children are gone; reap any descendants they outlived (best-effort)
      for (const pid of spawnedPids) void killTree(pid);
    }
  };
