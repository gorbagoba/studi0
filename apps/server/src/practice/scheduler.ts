import type { Config } from '../config.js';

export interface NextSchedule {
  intervalDays: number;
  intervalIndex: number;
}

/**
 * Successive-relearning ladder [1,3,7,14,30]: a correct answer only advances
 * the rung once the student has 3 consecutive corrects on the current rung
 * (criterion-gated); a wrong answer resets to the 1-day rung. `correctStreak`
 * is the streak BEFORE this answer. `intervalIndex` is the rung to use next.
 */
export function nextSchedule(
  intervalIndex: number,
  correct: boolean,
  cfg: Config,
  correctStreak = 0,
): NextSchedule {
  const last = cfg.ladder.length - 1;
  if (!correct) return { intervalDays: cfg.ladder[0] as number, intervalIndex: 0 };
  const idx = Math.min(Math.max(intervalIndex, 0), last);
  const advance = (correctStreak + 1) % 3 === 0;
  const nextIdx = advance ? Math.min(idx + 1, last) : idx;
  return {
    intervalDays: cfg.ladder[nextIdx] as number,
    intervalIndex: nextIdx,
  };
}
