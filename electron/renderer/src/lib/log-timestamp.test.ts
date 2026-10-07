import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatLogTimestamp } from './log-timestamp.js';

const previousTimezone = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/New_York'; });
afterAll(() => {
  if (previousTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimezone;
});

describe('Diagnostics local timestamps', () => {
  const now = new Date('2026-10-07T02:00:00Z'); // Oct 6 at 22:00 locally.
  it('shows local time for the same local date across a UTC date boundary', () => {
    expect(formatLogTimestamp('2026-10-06T23:00:00Z', now)).toBe('19:00:00');
  });
  it('prefixes the date for an older local day even when UTC dates match', () => {
    expect(formatLogTimestamp('2026-10-07T02:00:00Z', new Date('2026-10-07T05:00:00Z')))
      .toMatch(/6.*22:00:00$/);
  });
  it('includes the year for entries from another year', () => {
    expect(formatLogTimestamp('2025-10-06T23:00:00Z', now)).toMatch(/2025.*19:00:00$/);
  });
  it.each([null, undefined, '', 'malformed'])('handles missing or invalid timestamps: %s', ts => {
    expect(formatLogTimestamp(ts, now)).toBe('—');
  });
  it.each([
    ['2026-03-08T06:59:00Z', '01:59:00'],
    ['2026-03-08T07:01:00Z', '03:01:00'],
  ])('uses the correct local offset at the daylight-saving boundary: %s', (ts, expected) => {
    expect(formatLogTimestamp(ts, new Date('2026-03-08T12:00:00Z'))).toBe(expected);
  });
});
