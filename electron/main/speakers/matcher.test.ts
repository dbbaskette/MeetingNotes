import { describe, it, expect } from 'vitest';
import { matchSpeakers, updateRunningAverage, MATCH_THRESHOLD } from './matcher';

describe('matchSpeakers', () => {
  const roster = [
    { id: 'spk_a', embedding: [1, 0, 0] },
    { id: 'spk_b', embedding: [0, 1, 0] },
  ];

  it('auto-links when cosine >= threshold', () => {
    const out = matchSpeakers([{ label: 'Speaker 1', embedding: [0.99, 0.01, 0] }], roster);
    expect(out[0]!.rosterId).toBe('spk_a');
    expect(out[0]!.confidence).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it('leaves unlinked when no match exceeds threshold', () => {
    const out = matchSpeakers([{ label: 'Speaker 2', embedding: [0, 0, 1] }], roster);
    expect(out[0]!.rosterId).toBeNull();
  });

  it('handles empty roster', () => {
    const out = matchSpeakers([{ label: 'S', embedding: [1, 0, 0] }], []);
    expect(out[0]!.rosterId).toBeNull();
  });
});

describe('updateRunningAverage', () => {
  it('uses 0.7 old + 0.3 new', () => {
    const r = updateRunningAverage([1, 0], [0, 1]);
    expect(r[0]).toBeCloseTo(0.7, 6);
    expect(r[1]).toBeCloseTo(0.3, 6);
  });
});
