import { describe, expect, it } from 'vitest';
import { speakerReviewLayout } from './speaker-review-layout.js';

describe('speaker review row layout', () => {
  it('keeps the identity details readable when badges and selection are present', () => {
    const layout = speakerReviewLayout();

    expect(layout.button).toContain('items-start');
    expect(layout.details).toContain('min-w-0');
    expect(layout.status).toContain('flex-wrap');
  });
});
