import { describe, expect, it } from 'vitest';
import { createCountsCache } from './page-counts.js';

describe('createCountsCache', () => {
  it('computes counts on the first page and reuses them for continuation pages of the same query', () => {
    let loads = 0;
    const counts = { all: 10, pending: 1, processing: 2, done: 6, failed: 1 };
    const cache = createCountsCache();
    const load = (): typeof counts => { loads++; return counts; };
    expect(cache.forQuery({ filter: 'all', sort: 'newest' }, load)).toBe(counts);
    expect(cache.forQuery({ filter: 'all', sort: 'newest', cursor: 'page-2' }, load)).toBe(counts);
    expect(cache.forQuery({ filter: 'all', sort: 'newest', cursor: 'page-3' }, load)).toBe(counts);
    expect(loads).toBe(1);
    expect(cache.forQuery({ filter: 'pending', sort: 'newest' }, load)).toBe(counts);
    expect(loads).toBe(2);
    expect(cache.forQuery({ filter: 'all', sort: 'newest' }, load)).toBe(counts);
    expect(loads).toBe(3);
  });
});
