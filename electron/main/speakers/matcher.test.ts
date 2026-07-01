import { describe, it, expect } from 'vitest';
import { matchSpeakers, updateRunningAverage, rankCandidates, MATCH_THRESHOLD } from './matcher.js';

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

describe('rankCandidates', () => {
  const roster = [
    { id: 'spk_a', embedding: [1, 0, 0] },
    { id: 'spk_b', embedding: [0.6, 0.8, 0] },
    { id: 'spk_c', embedding: [0, 1, 0] },
  ];

  it('ranks every roster entry by similarity, best first', () => {
    const out = rankCandidates({ label: 'Speaker 1', embedding: [0.9, 0.1, 0] }, roster);
    expect(out.map((c) => c.id)).toEqual(['spk_a', 'spk_b', 'spk_c']);
  });

  it('includes candidates below MATCH_THRESHOLD, unlike matchSpeakers', () => {
    // spk_b at [0.6, 0.8, 0] is close but not close enough to auto-link
    // against [0.9, 0.1, 0] — matchSpeakers would discard it entirely.
    const detected = { label: 'Speaker 1', embedding: [0.9, 0.1, 0] };
    const auto = matchSpeakers([detected], roster);
    expect(auto[0]!.rosterId).toBe('spk_a'); // only the best match survives, and only if >= threshold
    const ranked = rankCandidates(detected, roster);
    expect(ranked.length).toBe(3); // all three roster entries, regardless of threshold
    expect(ranked.some((c) => c.confidence < MATCH_THRESHOLD)).toBe(true);
  });

  it('respects the topN cap', () => {
    const out = rankCandidates({ label: 'S', embedding: [1, 0, 0] }, roster, 2);
    expect(out).toHaveLength(2);
  });

  it('skips roster entries with mismatched embedding dimensions', () => {
    const out = rankCandidates(
      { label: 'S', embedding: [1, 0, 0] },
      [...roster, { id: 'spk_bad_dim', embedding: [1, 0] }],
    );
    expect(out.some((c) => c.id === 'spk_bad_dim')).toBe(false);
  });

  it('handles an empty roster', () => {
    expect(rankCandidates({ label: 'S', embedding: [1, 0, 0] }, [])).toEqual([]);
  });
});

describe('updateRunningAverage', () => {
  it('uses 0.7 old + 0.3 new', () => {
    const r = updateRunningAverage([1, 0], [0, 1]);
    expect(r[0]).toBeCloseTo(0.7, 6);
    expect(r[1]).toBeCloseTo(0.3, 6);
  });
});
