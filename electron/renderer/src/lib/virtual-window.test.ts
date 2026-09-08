import { describe, expect, it } from 'vitest';
import { retainedRowIndexes, virtualWindow } from './virtual-window';

const base = { count: 1_000, rowHeight: 72, viewportHeight: 700, overscan: 5 };

describe('virtualWindow', () => {
  it.each([
    [0, { start: 0, end: 15, offset: 0, totalHeight: 72_000 }],
    [36_000, { start: 495, end: 515, offset: 35_640, totalHeight: 72_000 }],
    [71_300, { start: 985, end: 1_000, offset: 70_920, totalHeight: 72_000 }],
  ])('covers the viewport and overscan at scrollTop %i', (scrollTop, expected) => {
    expect(virtualWindow({ ...base, scrollTop })).toEqual(expected);
  });

  it('returns an empty range and spacer for no rows', () => {
    expect(virtualWindow({ ...base, count: 0, scrollTop: 500 })).toEqual({ start: 0, end: 0, offset: 0, totalHeight: 0 });
  });

  it('clamps negative and excessive overscan to valid indexes', () => {
    expect(virtualWindow({ ...base, scrollTop: 36_000, overscan: -20 })).toEqual({ start: 500, end: 510, offset: 36_000, totalHeight: 72_000 });
    expect(virtualWindow({ ...base, count: 3, scrollTop: 0, overscan: 5_000 })).toEqual({ start: 0, end: 3, offset: 0, totalHeight: 216 });
  });

  it('keeps partial rows visible and expands when the viewport grows', () => {
    expect(virtualWindow({ ...base, scrollTop: 36_050, viewportHeight: 350 })).toEqual({ start: 495, end: 511, offset: 35_640, totalHeight: 72_000 });
    expect(virtualWindow({ ...base, scrollTop: 36_050, viewportHeight: 700 })).toEqual({ start: 495, end: 516, offset: 35_640, totalHeight: 72_000 });
  });

  it('clamps stale scroll offsets after shrinking the row collection', () => {
    expect(virtualWindow({ ...base, count: 20, scrollTop: 36_000 })).toEqual({ start: 5, end: 20, offset: 360, totalHeight: 1_440 });
    expect(virtualWindow({ ...base, scrollTop: -100 })).toEqual({ start: 0, end: 15, offset: 0, totalHeight: 72_000 });
  });

  it('mounts fewer than 40 slots throughout a 1,000-row, 700px viewport', () => {
    for (let scrollTop = 0; scrollTop <= 72_000; scrollTop += 37) {
      const { start, end } = virtualWindow({ ...base, scrollTop });
      expect(end - start).toBeLessThan(40);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(1_000);
    }
  });
});

describe('retainedRowIndexes', () => {
  const items = Array.from({ length: 1_000 }, (_, index) => ({ id: `meeting-${index}` }));

  it('keeps an open dialog owner after focus no longer retains the row', () => {
    expect(retainedRowIndexes({ items, start: 495, end: 498, retainedIds: ['meeting-0'] })).toEqual([0, 495, 496, 497]);
  });

  it('releases only the closed dialog owner while preserving another retained row', () => {
    expect(retainedRowIndexes({ items, start: 495, end: 498, retainedIds: ['meeting-999'] })).toEqual([495, 496, 497, 999]);
    expect(retainedRowIndexes({ items, start: 495, end: 498, retainedIds: [] })).toEqual([495, 496, 497]);
  });

  it('deduplicates focus and dialog pins without duplicating visible rows', () => {
    expect(retainedRowIndexes({ items, start: 495, end: 498, retainedIds: ['meeting-0', 'meeting-0', 'meeting-496'] })).toEqual([0, 495, 496, 497]);
  });

  it('tracks retained IDs through reorder and omits removed owners', () => {
    expect(retainedRowIndexes({ items: [{ id: 'b' }, { id: 'c' }, { id: 'a' }], start: 0, end: 1, retainedIds: ['a', 'deleted'] })).toEqual([0, 2]);
  });
});
