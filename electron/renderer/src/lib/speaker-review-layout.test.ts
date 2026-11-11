import { describe, expect, it } from 'vitest';
import { partitionSpeakerReview, speakerReviewLayout } from './speaker-review-layout.js';

describe('speaker review row layout', () => {
  it('keeps the identity details readable when badges and selection are present', () => {
    const layout = speakerReviewLayout();

    expect(layout.button).toContain('items-start');
    expect(layout.details).toContain('min-w-0');
    expect(layout.status).toContain('flex-wrap');
  });

  it('lists voices that need review above already-named voices, preserving order in each group', () => {
    const speakers = [
      { localLabel: 'SPEAKER_00', needsReview: false },
      { localLabel: 'SPEAKER_01', needsReview: true },
      { localLabel: 'SPEAKER_02', needsReview: false },
      { localLabel: 'SPEAKER_03', needsReview: true },
    ];
    expect(partitionSpeakerReview(speakers)).toEqual({
      needsReview: [
        { localLabel: 'SPEAKER_01', needsReview: true },
        { localLabel: 'SPEAKER_03', needsReview: true },
      ],
      rest: [
        { localLabel: 'SPEAKER_00', needsReview: false },
        { localLabel: 'SPEAKER_02', needsReview: false },
      ],
      brief: [],
    });
  });

  it('sets barely-heard unnamed voices apart from review work and named voices', () => {
    const brief = { localLabel: 'SPEAKER_04', rosterId: null, needsReview: false, durationS: 4, segmentCount: 2 };
    const unknown = { localLabel: 'SPEAKER_05', rosterId: null, needsReview: true, durationS: 40, segmentCount: 9 };
    const quietButNamed = { localLabel: 'SPEAKER_06', rosterId: 'alice', needsReview: false, durationS: 4, segmentCount: 2 };
    expect(partitionSpeakerReview([brief, unknown, quietButNamed])).toEqual({
      needsReview: [unknown], rest: [quietButNamed], brief: [brief],
    });
  });
});
