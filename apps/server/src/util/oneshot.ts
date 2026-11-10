import type { Config } from '../config.js';
import { spawnArgs, resolveOpencodeBin, killTree, killTreeWithDeadline } from './proc.js';
import { stripStepMarkers } from '../pipeline/parse.js';
import { graphEnv } from '../graph/backendEnv.js';

export type OneshotFn = (cwd: string, prompt: string, signal?: AbortSignal) => Promise<string>;

export interface OneshotOpts {
  /** run as a specific (execute-capable) agent instead of the default */
  agent?: string;
  /** override the kill timeout — whole-course generation needs far more than oneshotTimeoutMs */
  timeoutMs?: number;
  /** `opencode run --model`; unset = the global default model */
  model?: string;
}

/**
 * One-shot headless `opencode run` — used by pipeline verification, rotation
 * summaries, practice generation/verification/grading, and teacher setup runs.
 * Same spawn/kill semantics as the pipeline runner (arg array, shell:false,
 * opencode resolved to a real executable).
 */
export const makeOneshot =
  (cfg: Config, opts: OneshotOpts = {}): OneshotFn =>
  async (cwd, prompt, signal) => {
    if (!resolveOpencodeBin()) {
      const err = new Error('OPENCODE_DOWN: opencode CLI not found');
      (err as NodeJS.ErrnoException).name = 'OneshotDown';
      throw err;
    }
    // --standalone: private server inside the kill-tree (same as pipeline runner);
    // --agent: the default agent is plan-only and would never execute writes
    const args = ['run', '--auto'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.agent) args.push('--agent', opts.agent);
    args.push('--standalone', prompt);
    const { done, child } = spawnArgs(args, cwd, graphEnv(cfg));
    // same kill semantics as the pipeline runner: the tree, not just the child
    const kill = () => {
      if (child.pid !== undefined) killTreeWithDeadline(child.pid);
      else child.kill();
    };
    signal?.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(() => {
      if (child.exitCode === null) kill();
    }, opts.timeoutMs ?? cfg.oneshotTimeoutMs);
    timer.unref();
    try {
      const res = await done;
      if (res.code !== 0) {
        // stderr tail stays in server logs — clients only get a generic message
        const tail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
        console.error(`[oneshot] opencode run failed (${res.code}): ${tail || 'no stderr'}`);
        throw new Error(`opencode run failed (${res.code})`);
      }
      return stripStepMarkers(res.stdout);
    } finally {
      signal?.removeEventListener('abort', kill);
      clearTimeout(timer);
      // the direct child is gone; reap any descendants it outlived (best-effort)
      if (child.pid !== undefined) void killTree(child.pid);
    }
  };
