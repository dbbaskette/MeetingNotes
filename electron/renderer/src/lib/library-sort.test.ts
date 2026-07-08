import { describe, it, expect } from 'vitest';
import { libraryComparator, sanitizeSortKey, type SortableMeeting } from './library-sort';

function m(over: Partial<SortableMeeting> & { title: string }): SortableMeeting {
  return { status: 'done', startedAt: null, durationS: null, ...over };
}

describe('sanitizeSortKey', () => {
  it('passes valid keys through', () => {
    expect(sanitizeSortKey('newest')).toBe('newest');
    expect(sanitizeSortKey('oldest')).toBe('oldest');
    expect(sanitizeSortKey('longest')).toBe('longest');
    expect(sanitizeSortKey('title')).toBe('title');
  });

  it('falls back to newest for junk (corrupt/missing localStorage)', () => {
    expect(sanitizeSortKey(null)).toBe('newest');
    expect(sanitizeSortKey(undefined)).toBe('newest');
    expect(sanitizeSortKey('shortest')).toBe('newest');
    expect(sanitizeSortKey(42)).toBe('newest');
  });
});

describe('libraryComparator — status buckets stay pinned for every key', () => {
  const list = [
    m({ title: 'Done new', status: 'done', startedAt: '2026-07-07T10:00:00Z' }),
    m({ title: 'Pending', status: 'pending', startedAt: '2026-01-01T10:00:00Z' }),
    m({ title: 'Failed', status: 'failed', startedAt: '2026-07-06T10:00:00Z' }),
    m({ title: 'Processing', status: 'processing', startedAt: '2026-03-01T10:00:00Z' }),
    m({ title: 'Awaiting', status: 'awaiting_user', startedAt: '2026-02-01T10:00:00Z' }),
    m({ title: 'Mystery', status: 'someday', startedAt: '2026-07-08T10:00:00Z' }),
  ];
  for (const key of ['newest', 'oldest', 'longest', 'title'] as const) {
    it(`${key}: pending/awaiting/processing/failed stay above done`, () => {
      const sorted = [...list].sort(libraryComparator(key));
      expect(sorted.map((x) => x.status)).toEqual(
        ['pending', 'awaiting_user', 'processing', 'failed', 'done', 'someday'],
      );
    });
  }
});

describe('libraryComparator — within a bucket', () => {
  const a = m({ title: 'Alpha', startedAt: '2026-07-01T10:00:00Z', durationS: 600 });
  const b = m({ title: 'beta', startedAt: '2026-07-03T10:00:00Z', durationS: 3600 });
  const c = m({ title: 'Gamma', startedAt: '2026-07-02T10:00:00Z', durationS: 60 });
  const noDate = m({ title: 'Undated', startedAt: null, durationS: 1800 });
  const noDur = m({ title: 'Unmeasured', startedAt: '2026-07-04T10:00:00Z', durationS: null });

  it('newest: recency desc, null startedAt last (current default behavior)', () => {
    const sorted = [...[a, noDate, b, c]].sort(libraryComparator('newest'));
    expect(sorted.map((x) => x.title)).toEqual(['beta', 'Gamma', 'Alpha', 'Undated']);
  });

  it('oldest: recency asc, null startedAt still last', () => {
    const sorted = [...[a, noDate, b, c]].sort(libraryComparator('oldest'));
    expect(sorted.map((x) => x.title)).toEqual(['Alpha', 'Gamma', 'beta', 'Undated']);
  });

  it('longest: duration desc, null durationS last', () => {
    const sorted = [...[a, noDur, b, c]].sort(libraryComparator('longest'));
    expect(sorted.map((x) => x.title)).toEqual(['beta', 'Alpha', 'Gamma', 'Unmeasured']);
  });

  it('longest: equal durations tiebreak by recency', () => {
    const x = m({ title: 'X', startedAt: '2026-07-01T10:00:00Z', durationS: 600 });
    const y = m({ title: 'Y', startedAt: '2026-07-02T10:00:00Z', durationS: 600 });
    const sorted = [...[x, y]].sort(libraryComparator('longest'));
    expect(sorted.map((s) => s.title)).toEqual(['Y', 'X']);
  });

  it('title: case-insensitive A–Z', () => {
    const sorted = [...[c, b, a]].sort(libraryComparator('title'));
    expect(sorted.map((x) => x.title)).toEqual(['Alpha', 'beta', 'Gamma']);
  });

  it('title: identical titles tiebreak by recency', () => {
    const x = m({ title: 'Standup', startedAt: '2026-07-01T10:00:00Z' });
    const y = m({ title: 'standup', startedAt: '2026-07-02T10:00:00Z' });
    const sorted = [...[x, y]].sort(libraryComparator('title'));
    expect(sorted[0]).toBe(y);
  });

  it('all-null fields do not throw and compare stably', () => {
    const x = m({ title: 'A' });
    const y = m({ title: 'B' });
    expect(libraryComparator('newest')(x, y)).toBe(0);
    expect(libraryComparator('oldest')(x, y)).toBe(0);
    expect(libraryComparator('longest')(x, y)).toBe(0);
    expect(libraryComparator('title')(x, y)).toBeLessThan(0);
  });
});
