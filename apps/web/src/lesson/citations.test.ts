import { CITATION_RE } from '@studi0/shared';
import { describe, expect, it } from 'vitest';

describe('CITATION_RE', () => {
  it('splits message text keeping citation markers at odd indices', () => {
    expect('before 【heaps.pdf · p12】 after'.split(CITATION_RE)).toEqual([
      'before ',
      '【heaps.pdf · p12】',
      ' after',
    ]);
  });

  it('handles multiple markers and text without any', () => {
    expect('【a.md · p1】mid【b.md · p2】'.split(CITATION_RE)).toHaveLength(5);
    expect('no citations here'.split(CITATION_RE)).toEqual(['no citations here']);
  });
});
