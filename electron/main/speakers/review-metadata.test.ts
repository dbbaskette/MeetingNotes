import { describe, expect, it } from 'vitest';
import { buildSpeakerReviewMetadata } from './review-metadata.js';

describe('buildSpeakerReviewMetadata', () => {
  it('does not call even a perfect automatic match human-confirmed', () => {
    const result = buildSpeakerReviewMetadata({
      links: [{ localLabel: 'A', rosterId: 'alice', displayName: 'Alice', confidence: 1, assignmentSource: 'automatic' }],
      diarization: [{ speaker: 'A', start: 0, end: 6 }, { speaker: 'A', start: 10, end: 16 }], transcript: [],
    });
    expect(result.get('A')).toMatchObject({ state: 'automatic', needsReview: false });
  });
  it('distinguishes unknown, probable, and manually confirmed speakers with impact counts', () => {
    const result = buildSpeakerReviewMetadata({
      links: [
        { localLabel: 'SPEAKER_00', rosterId: null, displayName: null, confidence: 0 },
        { localLabel: 'SPEAKER_01', rosterId: 'alice', displayName: 'Alice', confidence: 0.86 },
        { localLabel: 'SPEAKER_02', rosterId: 'bob', displayName: 'Bob', confidence: 1 },
      ],
      diarization: [
        { speaker: 'SPEAKER_00', start: 0, end: 1 },
        { speaker: 'SPEAKER_00', start: 20, end: 31 },
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

  it('does not hold a meeting for an unnamed voice with under ten seconds of speech', () => {
    const result = buildSpeakerReviewMetadata({
      links: [
        { localLabel: 'BRIEF', rosterId: null, displayName: null, confidence: 0 },
        { localLabel: 'TEN', rosterId: null, displayName: null, confidence: 0 },
        { localLabel: 'NAMED', rosterId: 'alice', displayName: 'Alice', confidence: 0.5 },
        { localLabel: 'NO_EVIDENCE', rosterId: null, displayName: null, confidence: 0 },
      ],
      diarization: [
        { speaker: 'BRIEF', start: 0, end: 4 }, { speaker: 'BRIEF', start: 5, end: 10.9 },
        { speaker: 'TEN', start: 20, end: 25 }, { speaker: 'TEN', start: 30, end: 35 },
        { speaker: 'NAMED', start: 40, end: 42 }, { speaker: 'NAMED', start: 43, end: 45 },
      ], transcript: [],
    });
    expect(result.get('BRIEF')).toMatchObject({ state: 'unknown', needsReview: false });
    expect(result.get('TEN')).toMatchObject({ state: 'unknown', needsReview: true });
    // A weakly matched name is still reviewed however little it spoke, and
    // an unknown voice with no diarization evidence is never waved through.
    expect(result.get('NAMED')).toMatchObject({ needsReview: true });
    expect(result.get('NO_EVIDENCE')).toMatchObject({ needsReview: true });
  });

  it('counts lines and duration once across many speakers instead of rescanning per link', () => {
    const links = Array.from({ length: 40 }, (_, i) => ({
      localLabel: `SPEAKER_${String(i).padStart(2, '0')}`,
      rosterId: i % 2 === 0 ? null : `id-${i}`,
      displayName: i % 2 === 0 ? null : `Name ${i}`,
      confidence: i % 2 === 0 ? 0 : 0.9,
    }));
    const diarization = links.flatMap((link, i) => [
      { speaker: link.localLabel, start: i * 4, end: i * 4 + 2 },
      { speaker: link.localLabel, start: i * 4 + 2, end: i * 4 + 3 },
    ]);
    const transcript = links.map((link, i) => ({
      start: i * 4, end: i * 4 + 1.5, text: link.localLabel,
    }));
    const result = buildSpeakerReviewMetadata({ links, diarization, transcript });
    expect(result.get('SPEAKER_00')).toMatchObject({ lineCount: 1, durationS: 3, segmentCount: 2, needsReview: false });
    expect(result.get('SPEAKER_01')).toMatchObject({ lineCount: 1, durationS: 3, segmentCount: 2, needsReview: false });
    expect(result.size).toBe(40);
  });
});
