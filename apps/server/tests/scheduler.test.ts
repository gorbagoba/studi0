import { describe, expect, it, afterEach } from 'vitest';
import { makeHarness } from './helpers';
import { nextSchedule } from '../src/practice/scheduler.js';

let h: Awaited<ReturnType<typeof makeHarness>>;

afterEach(async () => {
  if (h) await h.close();
});

describe('successive-relearning scheduler [1,3,7,14,30] (criterion-gated)', () => {
  it('consecutive corrects stay on the 1-day rung until the 3-correct criterion', async () => {
    h = await makeHarness();
    expect(nextSchedule(0, true, h.ctx.cfg, 0)).toEqual({ intervalDays: 1, intervalIndex: 0 });
    expect(nextSchedule(0, true, h.ctx.cfg, 1)).toEqual({ intervalDays: 1, intervalIndex: 0 });
  });

  it('the 3rd consecutive correct advances to the 3-day rung', async () => {
    h = await makeHarness();
    expect(nextSchedule(0, true, h.ctx.cfg, 2)).toEqual({ intervalDays: 3, intervalIndex: 1 });
  });

  it('every further 3-streak advances one rung: 7, then 14, then 30', async () => {
    h = await makeHarness();
    expect(nextSchedule(1, true, h.ctx.cfg, 5)).toEqual({ intervalDays: 7, intervalIndex: 2 });
    expect(nextSchedule(2, true, h.ctx.cfg, 8)).toEqual({ intervalDays: 14, intervalIndex: 3 });
    expect(nextSchedule(3, true, h.ctx.cfg, 11)).toEqual({ intervalDays: 30, intervalIndex: 4 });
  });

  it('caps at the 30-day rung on a long streak', async () => {
    h = await makeHarness();
    expect(nextSchedule(4, true, h.ctx.cfg, 20)).toEqual({ intervalDays: 30, intervalIndex: 4 });
  });

  it('wrong answer resets to the 1-day rung', async () => {
    h = await makeHarness();
    expect(nextSchedule(3, false, h.ctx.cfg, 9)).toEqual({ intervalDays: 1, intervalIndex: 0 });
  });
});
