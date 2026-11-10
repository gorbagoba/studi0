import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { killTreeWithDeadline } from '../util/proc.js';
import { graphEnv } from './backendEnv.js';
import type { Config } from '../config.js';

export type GraphifyExtractResult = { ok: true } | { ok: false; error: string };

export interface GraphifyExtractOpts {
  cfg: Config;
  subjectPath: string;
  log: (message: string) => void;
  signal?: AbortSignal;
  /** default 45 minutes — headless agents capped at ~2 minutes could never finish */
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
  /** job pid bookkeeping: the boot cleanup kill-trees a graphify left behind by a restart */
  onPid?: (pid: number | undefined) => void;
}

const CLUSTER_TIMEOUT_MS = 10 * 60_000;

/** A checkpointed chunk cache makes a second pass cheap: only bad chunks are redone. */
const INCOMPLETE_EXTRACTION = /incomplete|truncated or hollow|produced no nodes|Refusing to overwrite/i;

interface StepOpts {
  cfg: Config;
  subjectPath: string;
  args: string[];
  label: string;
  timeoutMs: number;
  log: (message: string) => void;
  signal?: AbortSignal;
  onPid?: (pid: number | undefined) => void;
  onLine?: (line: string) => void;
}

interface StepResult {
  error: string | null;
  output: string;
}

/** Run one graphify command from the subject root; resolves to its error (if any) and full output. */
function runStep(opts: StepOpts): Promise<StepResult> {
  const { cfg, subjectPath, args, label, log, signal } = opts;
  const timeout = opts.timeoutMs % 60_000 === 0 ? `${opts.timeoutMs / 60_000}m` : `${opts.timeoutMs}ms`;
  return new Promise((resolve) => {
    log(`graphify: running ${args.join(' ')}`);
    const child = spawn(cfg.graphifyBin || 'graphify', args, {
      cwd: subjectPath,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, ...graphEnv(cfg) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    opts.onPid?.(child.pid);
    const lines: string[] = [];
    let timedOut = false;
    let settled = false;
    const kill = () => {
      if (child.pid !== undefined) killTreeWithDeadline(child.pid);
      else child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', kill, { once: true });
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({ error, output: lines.join('\n') });
    };

    const pipeLines = (stream: NodeJS.ReadableStream | null) => {
      let tail = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        tail += chunk;
        let idx: number;
        while ((idx = tail.indexOf('\n')) >= 0) {
          emit(tail.slice(0, idx));
          tail = tail.slice(idx + 1);
        }
      });
      return () => emit(tail);
    };
    const emit = (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      lines.push(line);
      log(`graphify: ${line.slice(0, 160)}`);
      opts.onLine?.(line);
    };
    const flushOut = pipeLines(child.stdout);
    const flushErr = pipeLines(child.stderr);

    child.on('error', (e) => finish(`${label} failed to start: ${e.message}`));
    child.on('close', (code) => {
      flushOut();
      flushErr();
      if (timedOut) finish(`${label} timed out after ${timeout}`);
      else if (code !== 0) finish(`${label} exited with code ${code}`);
      else finish(null);
    });
  });
}

/**
 * Extraction is server-owned: graphify runs here with its own long timeout, so
 * no agent turn (and no ~120s shell cap) can cut a 51-file build in half.
 */
export async function runGraphifyExtract({
  cfg,
  subjectPath,
  log,
  signal,
  timeoutMs = 45 * 60_000,
  onProgress,
  onPid,
}: GraphifyExtractOpts): Promise<GraphifyExtractResult> {
  // one budget for both attempts — a retry only runs while time is left
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const args = ['extract', 'material', '--out', '.', '--token-budget', String(cfg.graphTokenBudget)];
  const runExtract = () =>
    runStep({
      cfg,
      subjectPath,
      log,
      signal,
      onPid,
      label: 'graphify extraction',
      timeoutMs: remaining(),
      args,
      onLine: (line) => {
        const m = line.match(/chunk (\d+)\/(\d+)/);
        if (!m) return;
        const done = Number(m[1]);
        const total = Number(m[2]);
        log(`progress ${done}/${total}`);
        onProgress?.(done, total);
      },
    });

  let attempt = await runExtract();
  // graphify checkpoints every good chunk, so one re-run retries only the bad ones
  if (!signal?.aborted && attempt.error && remaining() > 0 && INCOMPLETE_EXTRACTION.test(attempt.output)) {
    log('retrying extraction (cache resumes)');
    attempt = await runExtract();
  }
  if (attempt.error) return { ok: false, error: attempt.error };
  const counts = attempt.output.match(/graph\.json: (\d+) nodes, (\d+) edges/i);
  if (counts) log(`graph.json: ${counts[1]} nodes, ${counts[2]} edges`);

  // cluster-only appends graphify-out/graph.json to its path argument: "." is the subject root
  const cluster = await runStep({
    cfg,
    subjectPath,
    log,
    signal,
    onPid,
    label: 'graphify cluster-only',
    timeoutMs: CLUSTER_TIMEOUT_MS,
    args: ['cluster-only', '.'],
  });
  if (cluster.error) return { ok: false, error: cluster.error };

  // exit 0 is not success: extraction that never wrote the graph did nothing
  return existsSync(path.join(subjectPath, 'graphify-out', 'graph.json'))
    ? { ok: true }
    : { ok: false, error: 'graphify extraction produced no graphify-out/graph.json' };
}
