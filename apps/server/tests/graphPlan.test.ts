import { describe, expect, it } from 'vitest';
import { planChunks, PLAN_LIMITS, type MaterialFile } from '../src/graph/plan.js';

const opts = { maxChunks: 8, maxFilesPerChunk: 3, maxBytesPerChunk: 2000 };

function files(sizes: number[]): MaterialFile[] {
  return sizes.map((bytes, i) => ({ relPath: `material/f-${String(i).padStart(2, '0')}.md`, bytes }));
}

describe('planChunks', () => {
  it('returns no chunks for no files', () => {
    expect(planChunks([], opts)).toEqual([]);
  });

  it('keeps a single file in one chunk', () => {
    const one = files([100]);
    expect(planChunks(one, opts)).toEqual([one]);
  });

  it('splits many files by the file cap without exceeding maxChunks', () => {
    const chunks = planChunks(files(Array(22).fill(50)), opts);
    expect(chunks.length).toBeLessThanOrEqual(opts.maxChunks);
    expect(chunks.length).toBe(Math.ceil(22 / opts.maxFilesPerChunk));
    expect(chunks.flat()).toHaveLength(22);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(opts.maxFilesPerChunk);
  });

  it('balances uneven sizes and honours the byte cap', () => {
    const chunks = planChunks(files([1900, 100, 700, 600, 500, 400, 300, 200, 100, 50]), opts);
    expect(chunks.flat()).toHaveLength(10);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(opts.maxFilesPerChunk);
      expect(chunk.reduce((n, f) => n + f.bytes, 0)).toBeLessThanOrEqual(opts.maxBytesPerChunk);
    }
    expect(chunks.length).toBeLessThanOrEqual(opts.maxChunks);
  });

  it('gives an oversized file its own chunk', () => {
    const chunks = planChunks(files([5000, 100, 100, 100]), opts);
    const oversized = chunks.find((chunk) => chunk.some((f) => f.bytes === 5000));
    expect(oversized).toEqual([{ relPath: 'material/f-00.md', bytes: 5000 }]);
    expect(chunks.flat()).toHaveLength(4);
  });

  it('is deterministic for the same input', () => {
    const input = files([300, 100, 900, 400, 200]);
    expect(planChunks(input, opts)).toEqual(planChunks([...input].reverse(), opts));
  });

  it('the shipped limits produce ≤24 chunks of ≤8 files', () => {
    const chunks = planChunks(files(Array(192).fill(1000)), PLAN_LIMITS);
    expect(chunks).toHaveLength(PLAN_LIMITS.maxChunks);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(PLAN_LIMITS.maxFilesPerChunk);
  });
});
