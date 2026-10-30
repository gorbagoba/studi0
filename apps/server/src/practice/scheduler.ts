import type { Config } from '../config.js';

export interface NextSchedule {
  intervalDays: number;
  intervalIndex: number;
}

/**
 * 1/3/7 ladder: correct → current rung (1d, then 3d, then 7d, stays 7d);
 * wrong → reset to the 1-day rung. `intervalIndex` is the rung to use next.
 */
export function nextSchedule(intervalIndex: number, correct: boolean, cfg: Config): NextSchedule {
  const last = cfg.ladder.length - 1;
  if (!correct) return { intervalDays: cfg.ladder[0] as number, intervalIndex: 0 };
  const idx = Math.min(Math.max(intervalIndex, 0), last);
  return {
    intervalDays: cfg.ladder[idx] as number,
    intervalIndex: Math.min(idx + 1, last),
  };
}
