import { describe, it, expect } from 'vitest';
import { fmtDeletedAgo } from './trash-view';

describe('fmtDeletedAgo', () => {
  const now = new Date('2026-07-08T12:00:00Z');

  it('says "just now" under a minute', () => {
    expect(fmtDeletedAgo('2026-07-08T11:59:30Z', now)).toBe('just now');
    expect(fmtDeletedAgo('2026-07-08T12:00:00Z', now)).toBe('just now');
  });

  it('formats minutes, hours, and days', () => {
    expect(fmtDeletedAgo('2026-07-08T11:55:00Z', now)).toBe('5m ago');
    expect(fmtDeletedAgo('2026-07-08T09:00:00Z', now)).toBe('3h ago');
    expect(fmtDeletedAgo('2026-07-06T11:00:00Z', now)).toBe('2d ago');
    // 29 days — near the end of the 30-day retention window.
    expect(fmtDeletedAgo('2026-06-09T12:00:00Z', now)).toBe('29d ago');
  });

  it('rounds down to the largest whole unit', () => {
    // 1h 59m reads as hours, not 119 minutes.
    expect(fmtDeletedAgo('2026-07-08T10:01:00Z', now)).toBe('1h ago');
    // 23h 59m is still hours, not a day.
    expect(fmtDeletedAgo('2026-07-07T12:01:00Z', now)).toBe('23h ago');
  });

  it('falls back to the date part for unparseable input', () => {
    expect(fmtDeletedAgo('not-a-timestamp', now)).toBe('not-a-time');
    expect(fmtDeletedAgo('2026-13-99Tgarbage', now)).toBe('2026-13-99');
  });
});
