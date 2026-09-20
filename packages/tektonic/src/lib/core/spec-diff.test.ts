import { describe, it, expect } from 'vitest';
import { diffPaths } from './spec-diff';

describe('diffPaths', () => {
  it('returns nothing for identical values', () => {
    expect(diffPaths({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
  });

  it('reports a nested scalar difference by path', () => {
    expect(diffPaths({ spec: { steps: [{ image: 'a' }] } }, { spec: { steps: [{ image: 'b' }] } }))
      .toEqual(['spec.steps[0].image']);
  });

  it('reports differing array lengths with both counts', () => {
    expect(diffPaths({ steps: [1] }, { steps: [1, 2] })).toEqual(['steps (1 vs 2 entries)']);
  });

  it('reports a key present on only one side', () => {
    expect(diffPaths({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
  });

  it('ignores key order', () => {
    expect(diffPaths({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it('stops after the limit so a wholly different spec stays readable', () => {
    const a = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const b = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i + 1]));
    expect(diffPaths(a, b)).toHaveLength(10);
  });
});
