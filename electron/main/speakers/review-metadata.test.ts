import { describe, expect, it } from 'vitest';
import { buildSpeakerReviewMetadata } from './review-metadata.js';

describe('buildSpeakerReviewMetadata', () => {
  it('distinguishes unknown, probable, and manually confirmed speakers with impact counts', () => {
    const result = buildSpeakerReviewMetadata({
      links: [
        { localLabel: 'SPEAKER_00', rosterId: null, displayName: null, confidence: 0 },
        { localLabel: 'SPEAKER_01', rosterId: 'alice', displayName: 'Alice', confidence: 0.86 },
        { localLabel: 'SPEAKER_02', rosterId: 'bob', displayName: 'Bob', confidence: 1 },
      ],
      diarization: [
        { speaker: 'SPEAKER_00', start: 0, end: 1 },
        { speaker: 'SPEAKER_01', start: 1, end: 4 },
        { speaker: 'SPEAKER_01', start: 4, end: 7 },
        { speaker: 'SPEAKER_02', start: 7, end: 11 },
      ],
      transcript: [
        { start: 0, end: 1, text: 'Unknown' },
        { start: 1, end: 3, text: 'Alice one' },
        { start: 4, end: 6, text: 'Alice two' },
        { start: 8, end: 10, text: 'Bob' },
      ],
    });

    expect(result.get('SPEAKER_00')).toMatchObject({ state: 'unknown', needsReview: true, lineCount: 1 });
    expect(result.get('SPEAKER_01')).toMatchObject({ state: 'probable', needsReview: false, lineCount: 2, durationS: 6 });
    expect(result.get('SPEAKER_02')).toMatchObject({ state: 'confirmed', needsReview: true, lineCount: 1 });
  });
});
