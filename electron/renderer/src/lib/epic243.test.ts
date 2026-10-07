import { describe, it, expect, vi, afterEach } from 'vitest';
import { rowAt, rowOffsets } from './variable-window';
import { rememberGroupUndo, undoGroupMove } from './group-undo';
import { arrivalBaseline, acknowledgeArrivals } from './new-arrivals';
import { rememberDestination, recentGroups } from './recent-groups';
import { readBrowsePreferences, saveBrowsePreferences } from './library-browse-preferences';
afterEach(() => {
  vi.unstubAllGlobals();
});
function storage() {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
  return data;
}
describe('Epic 243 browse state', () => {
  it('baselines old backlog once and advances only on explicit acknowledgement', () => {
    storage();
    expect(arrivalBaseline('2026-10-07T10:00:00Z')).toBe('2026-10-07T10:00:00Z');
    expect(arrivalBaseline('2026-10-08T10:00:00Z')).toBe('2026-10-07T10:00:00Z');
    acknowledgeArrivals('2026-10-08T10:00:00Z');
    expect(arrivalBaseline()).toBe('2026-10-08T10:00:00Z');
  });
  it('stores only safe browse state and three deduplicated explicit destinations', () => {
    const data = storage();
    saveBrowsePreferences('failed', null);
    expect(readBrowsePreferences()).toEqual({ filter: 'failed', groupId: null });
    expect([...data.values()].some((value) => value.includes('query'))).toBe(false);
    for (const id of ['a', 'b', 'c', 'a', 'd']) rememberDestination(id);
    expect(recentGroups()).toEqual(['d', 'a', 'c']);
  });
  it('keeps old toast Undo bound to its own operation, while native Undo picks the latest', async () => {
    const first = vi.fn(async () => {}),
      second = vi.fn(async () => {});
    const toast = rememberGroupUndo(first);
    rememberGroupUndo(second);
    await toast();
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    await undoGroupMove();
    expect(second).toHaveBeenCalledOnce();
    await toast();
    await undoGroupMove();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
  it('binary-searches measured variable-height offsets including distant and end positions', () => {
    const offsets = rowOffsets(
      10000,
      () => 50,
      new Map([
        [2, 120],
        [7000, 240],
      ]),
    );
    expect(offsets).toHaveLength(10001);
    expect(rowAt(offsets, 0)).toBe(0);
    expect(rowAt(offsets, offsets[7000]! + 239)).toBe(7000);
    expect(rowAt(offsets, offsets[10000]!)).toBe(9999);
  });
});
