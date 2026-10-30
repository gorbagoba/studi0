import type { Config } from '../config.js';
import { spawnArgs, resolveOpencodeBin } from './proc.js';

export type OneshotFn = (cwd: string, prompt: string, signal?: AbortSignal) => Promise<string>;

/**
 * One-shot headless `opencode run` — used by pipeline verification, rotation
 * summaries, and practice generation/verification/grading. Same spawn/kill
 * semantics as the pipeline runner (arg array, shell:false, opencode resolved
 * to a real executable).
 */
export const makeOneshot =
  (cfg: Config): OneshotFn =>
  async (cwd, prompt, signal) => {
    if (!resolveOpencodeBin()) {
      const err = new Error('OPENCODE_DOWN: opencode CLI not found');
      (err as NodeJS.ErrnoException).name = 'OneshotDown';
      throw err;
    }
    const { done, child } = spawnArgs(['run', '--auto', prompt], cwd);
    const abort = () => {
      if (child.pid !== undefined) child.kill();
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      if (child.pid !== undefined && child.exitCode === null) child.kill();
    }, cfg.oneshotTimeoutMs);
    timer.unref();
    try {
      const res = await done;
      if (res.code !== 0) {
        throw new Error(`opencode run failed (${res.code}): ${res.stderr.slice(-2000) || 'no stderr'}`);
      }
      return res.stdout;
    } finally {
      signal?.removeEventListener('abort', abort);
      clearTimeout(timer);
    }
  };
