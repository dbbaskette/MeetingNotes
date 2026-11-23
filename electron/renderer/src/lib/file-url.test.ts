import { describe, it, expect } from 'vitest';
import { toFileUrl } from './file-url';

describe('toFileUrl', () => {
  it('encodes special URL characters (#, ?, %, spaces) in path segments', () => {
    expect(toFileUrl('/Users/dan/My Meetings/Q&A #1? 50% done.m4a')).toBe(
      'file:///Users/dan/My%20Meetings/Q%26A%20%231%3F%2050%25%20done.m4a',
    );
  });

  it('preserves standard POSIX absolute paths', () => {
    expect(toFileUrl('/Users/dan/Documents/MeetingNotes/recordings/rec-1.m4a')).toBe(
      'file:///Users/dan/Documents/MeetingNotes/recordings/rec-1.m4a',
    );
  });
});
