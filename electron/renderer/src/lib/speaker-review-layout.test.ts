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
    });
  });
});
