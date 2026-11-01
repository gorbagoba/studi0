// types for scripts/calibrate.mjs — the pure tier logic its tests import
export interface TierResult {
  tier: number;
  passed: number;
  total: number;
  slowest: number;
  ok: boolean;
  stderrTails?: string[];
}
export function runTier(
  tier: number,
  fire: () => Promise<{ ok: boolean; ms: number; stderrTail?: string }>,
  rounds?: number,
): Promise<TierResult>;
export function pickCap(results: TierResult[]): number | null;
