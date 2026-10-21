import { describe, expect, it } from 'vitest';
import { cleanSpeakerEvidence } from './clean-evidence.js';
const segment = (start: number, end: number, speaker = 'A') => ({ start, end, speaker });
describe('clean speaker evidence', () => {
  it('counts separate, exclusive turns', () => {
    expect(cleanSpeakerEvidence([segment(10, 16), segment(0, 6)]).get('A')).toEqual({ durationS: 12, turns: 2 });
  });
  it('does not count duplicate/overlapping/adjacent fragments as extra turns or duration', () => {
    expect(cleanSpeakerEvidence([segment(0, 4), segment(0, 4), segment(2, 6), segment(6, 12)]).get('A'))
      .toEqual({ durationS: 12, turns: 1 });
  });
  it('removes cross-speaker overlap without turning one monologue into two turns', () => {
    const evidence = cleanSpeakerEvidence([segment(0, 20), segment(8, 12, 'B')]);
    expect(evidence.get('A')).toEqual({ durationS: 16, turns: 1 });
    expect(evidence.get('B')).toEqual({ durationS: 0, turns: 0 });
  });
  it('does not count tiny isolated fragments as substantial turns', () => {
    expect(cleanSpeakerEvidence([segment(0, 0.5), segment(2, 14)]).get('A')).toEqual({ durationS: 12.5, turns: 1 });
  });
  it('fails closed for malformed timing', () => {
    for (const invalid of [segment(-1, 10), segment(2, Infinity), segment(NaN, 10), segment(3, 2)]) {
      expect(cleanSpeakerEvidence([segment(0, 6), invalid]).size).toBe(0);
    }
  });
  it('treats touching speakers as non-overlap', () => {
    const evidence = cleanSpeakerEvidence([segment(0, 6), segment(6, 12, 'B'), segment(12, 18)]);
    expect(evidence.get('A')).toEqual({ durationS: 12, turns: 2 });
    expect(evidence.get('B')).toEqual({ durationS: 6, turns: 1 });
  });
});
