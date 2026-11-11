import { describe, expect, it } from 'vitest';
import { SPEAKER_AUTO_MATCH, isBriefVoice, suggestedMatch } from './speaker-matching.js';

describe('speaker matching thresholds', () => {
  it('keeps the suggestion bar below the automatic bar', () => {
    expect(SPEAKER_AUTO_MATCH.suggestSimilarity).toBeLessThan(SPEAKER_AUTO_MATCH.similarity);
  });
});

describe('suggestedMatch', () => {
  const person = (id: string, confidence: number) => ({ id, confidence });
  it('offers the best candidate when it clears the bar and leads clearly', () => {
    expect(suggestedMatch([person('a', 0.72), person('b', 0.4)])).toEqual(person('a', 0.72));
    expect(suggestedMatch([person('a', 0.6)])).toEqual(person('a', 0.6));
  });
  it('offers nothing for a weak or contested best candidate', () => {
    expect(suggestedMatch([])).toBeNull();
    expect(suggestedMatch([person('a', 0.59)])).toBeNull();
    expect(suggestedMatch([person('a', 0.7), person('b', 0.66)])).toBeNull();
  });
});

describe('isBriefVoice', () => {
  it('is an unnamed voice with some, but under ten seconds of, speech', () => {
    expect(isBriefVoice({ rosterId: null, durationS: 9.9, segmentCount: 3 })).toBe(true);
    expect(isBriefVoice({ rosterId: null, durationS: 10, segmentCount: 3 })).toBe(false);
    expect(isBriefVoice({ rosterId: 'alice', durationS: 2, segmentCount: 1 })).toBe(false);
  });
  it('never treats missing evidence as brief', () => {
    expect(isBriefVoice({ rosterId: null, durationS: 0, segmentCount: 0 })).toBe(false);
    expect(isBriefVoice({ rosterId: null })).toBe(false);
  });
});
