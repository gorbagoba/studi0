import { describe, expect, it, afterEach } from 'vitest';
import { makeHarness } from './helpers';
import { nextSchedule } from '../src/practice/scheduler.js';

let h: Awaited<ReturnType<typeof makeHarness>>;

afterEach(async () => {
  if (h) await h.close();
});

describe('1/3/7 scheduler ladder (T07 / AC20)', () => {
  it('first correct answer schedules 1 day out', async () => {
    h = await makeHarness();
    expect(nextSchedule(0, true, h.ctx.cfg)).toEqual({ intervalDays: 1, intervalIndex: 1 });
  });

  it('second correct answer pushes to 3 days, third to 7', async () => {
    h = await makeHarness();
    expect(nextSchedule(1, true, h.ctx.cfg)).toEqual({ intervalDays: 3, intervalIndex: 2 });
    expect(nextSchedule(2, true, h.ctx.cfg)).toEqual({ intervalDays: 7, intervalIndex: 2 });
  });

  it('stays at 7 days on a long streak', async () => {
    h = await makeHarness();
    expect(nextSchedule(2, true, h.ctx.cfg)).toEqual({ intervalDays: 7, intervalIndex: 2 });
    expect(nextSchedule(9, true, h.ctx.cfg)).toEqual({ intervalDays: 7, intervalIndex: 2 });
  });

  it('wrong answer resets to the 1-day rung', async () => {
    h = await makeHarness();
    expect(nextSchedule(2, false, h.ctx.cfg)).toEqual({ intervalDays: 1, intervalIndex: 0 });
  });
});
