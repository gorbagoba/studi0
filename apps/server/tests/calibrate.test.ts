import { describe, expect, it } from 'vitest';
import { runTier, pickCap } from '../../../scripts/calibrate.mjs';
import type { TierResult } from '../../../scripts/calibrate.mjs';

const seq =
  (outcomes: { ok: boolean; ms: number }[]) =>
  () =>
    Promise.resolve(outcomes.shift() ?? { ok: false, ms: 0 });

describe('calibrate tier logic (pure — fake firer, no live opencode)', () => {
  it('runTier: passes when every fired child succeeds; slowest is the max ms', async () => {
    const res = await runTier(2, seq([
      { ok: true, ms: 100 },
      { ok: true, ms: 300 },
      { ok: true, ms: 200 },
      { ok: true, ms: 150 },
    ]));
    expect(res).toEqual({ tier: 2, passed: 4, total: 4, slowest: 300, ok: true, stderrTails: [] });
  });

  it('runTier: one failing child fails the tier but the rest still count', async () => {
    const res = await runTier(2, seq([
      { ok: true, ms: 10 },
      { ok: false, ms: 20 },
      { ok: true, ms: 30 },
      { ok: true, ms: 40 },
    ]));
    expect(res.ok).toBe(false);
    expect(res.passed).toBe(3);
    expect(res.total).toBe(4);
  });

  it('runTier: rounds multiply the children (tier 4 × 2 rounds = 8 fires)', async () => {
    let fires = 0;
    const res = await runTier(
      4,
      () => {
        fires++;
        return Promise.resolve({ ok: true, ms: 5 });
      },
      2,
    );
    expect(fires).toBe(8);
    expect(res.total).toBe(8);
    expect(res.ok).toBe(true);
  });

  it('pickCap: highest fully-passing tier, stopping at the first failure', () => {
    const ok = (tier: number): TierResult => ({ tier, passed: 1, total: 1, slowest: 1, ok: true });
    const bad = (tier: number): TierResult => ({ tier, passed: 0, total: 1, slowest: 1, ok: false });
    expect(pickCap([ok(2), ok(4), bad(6)])).toBe(4);
    expect(pickCap([ok(2), ok(4), ok(6), ok(8), ok(12)])).toBe(12); // 12 only reached when all prior pass
    expect(pickCap([bad(2)])).toBeNull(); // total failure at tier 2
    expect(pickCap([])).toBeNull();
  });
});
