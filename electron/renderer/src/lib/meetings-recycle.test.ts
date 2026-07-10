import { describe, it, expect } from 'vitest';
import { recycleMeetings, type MeetingRowLike } from './meetings-recycle';

/** Full-shape row so field-comparison blind spots show up as failures. */
function row(overrides: Partial<MeetingRowLike> & { id: string }): MeetingRowLike {
  return {
    slug: `slug-${overrides.id}`,
    title: `Meeting ${overrides.id}`,
    startedAt: '2026-07-01T10:00:00Z',
    durationS: 1800,
    pipelineStage: 'done',
    status: 'done',
    stageStartedAt: null,
    stageEtaMs: null,
    stageEtaRough: false,
    unidentifiedCount: 0,
    actionItemsCount: 2,
    speakers: [
      { localLabel: 'S1', rosterId: 'r1', displayName: 'Ada', confidence: 0.9 },
      { localLabel: 'S2', rosterId: null, displayName: null, confidence: null },
    ],
    ...overrides,
  };
}

/** Deep-clone via JSON so "same data, fresh objects" mimics an IPC response. */
const clone = (list: MeetingRowLike[]): MeetingRowLike[] =>
  JSON.parse(JSON.stringify(list)) as MeetingRowLike[];

describe('recycleMeetings', () => {
  it('returns the same array instance when nothing changed', () => {
    const prev = [row({ id: 'a' }), row({ id: 'b' })];
    expect(recycleMeetings(prev, clone(prev))).toBe(prev);
  });

  it('keeps old object references for unchanged rows when one row changed', () => {
    const prev = [
      row({ id: 'a' }),
      row({ id: 'b', status: 'processing', pipelineStage: 'transcribing', stageStartedAt: 't0' }),
      row({ id: 'c' }),
    ];
    const next = clone(prev);
    next[1] = { ...next[1]!, pipelineStage: 'diarizing', stageStartedAt: 't1' };

    const out = recycleMeetings(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]); // unchanged rows recycle their identity…
    expect(out[2]).toBe(prev[2]);
    expect(out[1]).toBe(next[1]); // …the changed row is the fresh object
    expect(out[1]!.pipelineStage).toBe('diarizing');
  });

  it('recycles survivors when a row is added', () => {
    const prev = [row({ id: 'a' }), row({ id: 'b' })];
    const next = [...clone(prev), row({ id: 'new', status: 'pending', pipelineStage: 'pending' })];
    const out = recycleMeetings(prev, next);
    expect(out).not.toBe(prev);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(prev[1]);
  });

  it('recycles survivors when a row is removed', () => {
    const prev = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    const next = clone(prev).filter((m) => m.id !== 'b');
    const out = recycleMeetings(prev, next);
    expect(out).not.toBe(prev);
    expect(out.map((m) => m.id)).toEqual(['a', 'c']);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(prev[2]);
  });

  it('returns a new array when only the order changed, but recycles every row', () => {
    const prev = [row({ id: 'a' }), row({ id: 'b' })];
    const next = clone(prev).reverse();
    const out = recycleMeetings(prev, next);
    expect(out).not.toBe(prev); // list changed → subscribers must re-render…
    expect(out[0]).toBe(prev[1]); // …but each row keeps its identity
    expect(out[1]).toBe(prev[0]);
  });

  it('detects a speaker rename with an unchanged speaker count', () => {
    const prev = [row({ id: 'a' })];
    const next = clone(prev);
    next[0]!.speakers[0]!.displayName = 'Grace';
    const out = recycleMeetings(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(next[0]);
    expect(out[0]!.speakers[0]!.displayName).toBe('Grace');
  });

  it('detects changes in every scalar field, not just the pipeline ones', () => {
    for (const patch of [
      { title: 'Renamed' },
      { startedAt: '2026-07-02T10:00:00Z' },
      { durationS: 60 },
      { stageEtaMs: 5000 },
      { stageEtaRough: true },
      { unidentifiedCount: 3 },
      { actionItemsCount: 9 },
    ] satisfies Partial<MeetingRowLike>[]) {
      const prev = [row({ id: 'a' })];
      const next = [{ ...clone(prev)[0]!, ...patch }];
      const out = recycleMeetings(prev, next);
      expect(out, JSON.stringify(patch)).not.toBe(prev);
      expect(out[0], JSON.stringify(patch)).toBe(next[0]);
    }
  });

  it('handles empty lists', () => {
    const prev: MeetingRowLike[] = [];
    expect(recycleMeetings(prev, [])).toBe(prev);
    expect(recycleMeetings(prev, [row({ id: 'a' })])).toHaveLength(1);
    expect(recycleMeetings([row({ id: 'a' })], [])).toEqual([]);
  });
});
