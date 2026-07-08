import { describe, it, expect } from 'vitest';
import { pruneSelection, partitionSelection } from './selection';

const meetings = [
  { id: 'p1', status: 'pending' },
  { id: 'd1', status: 'done' },
  { id: 'x1', status: 'processing' },
  { id: 'p2', status: 'pending' },
  { id: 'f1', status: 'failed' },
];

describe('pruneSelection', () => {
  it('drops ids that no longer exist in the meetings list', () => {
    const prev = new Set(['p1', 'gone', 'd1']);
    const next = pruneSelection(prev, meetings);
    expect([...next].sort()).toEqual(['d1', 'p1']);
  });

  it('returns the same set instance when nothing changed', () => {
    const prev = new Set(['p1', 'd1']);
    expect(pruneSelection(prev, meetings)).toBe(prev);
  });

  it('keeps non-pending statuses — every row is selectable now', () => {
    const prev = new Set(['d1', 'x1', 'f1']);
    expect(pruneSelection(prev, meetings)).toBe(prev);
  });

  it('handles an empty selection and an empty list', () => {
    const empty = new Set<string>();
    expect(pruneSelection(empty, meetings)).toBe(empty);
    const next = pruneSelection(new Set(['p1']), []);
    expect(next.size).toBe(0);
  });
});

describe('partitionSelection', () => {
  it('splits into pending-only (Process) and everything (Delete)', () => {
    const selected = new Set(['p1', 'd1', 'p2', 'f1']);
    const { pendingIds, allIds } = partitionSelection(selected, meetings);
    expect(pendingIds).toEqual(['p1', 'p2']);
    expect(allIds).toEqual(['p1', 'd1', 'p2', 'f1']);
  });

  it('preserves meetings-list order, not selection insertion order', () => {
    const selected = new Set(['f1', 'p1']); // inserted "backwards"
    const { allIds } = partitionSelection(selected, meetings);
    expect(allIds).toEqual(['p1', 'f1']);
  });

  it('ignores selected ids that are not in the list', () => {
    const selected = new Set(['p1', 'ghost']);
    const { pendingIds, allIds } = partitionSelection(selected, meetings);
    expect(pendingIds).toEqual(['p1']);
    expect(allIds).toEqual(['p1']);
  });

  it('returns empty arrays for an empty selection', () => {
    const { pendingIds, allIds } = partitionSelection(new Set(), meetings);
    expect(pendingIds).toEqual([]);
    expect(allIds).toEqual([]);
  });
});
