import { describe, it, expect } from 'vitest';
import { fmtDueLabel } from './due-date';

describe('fmtDueLabel', () => {
  const now = new Date('2026-07-01T15:00:00Z');
  const rangeEnd = '2026-07-05'; // end of the displayed week

  it('flags a date before today as overdue, regardless of the displayed week', () => {
    const result = fmtDueLabel('2026-06-10', rangeEnd, now);
    expect(result.tier).toBe('overdue');
    expect(result.label).toBe('Overdue — was due Wed, Jun 10');
  });

  it('does not flag today itself as overdue', () => {
    const result = fmtDueLabel('2026-07-01', rangeEnd, now);
    expect(result.tier).toBe('this-week');
  });

  it('keeps a date within the displayed week (and not yet past) as this-week', () => {
    const result = fmtDueLabel('2026-07-03', rangeEnd, now);
    expect(result.tier).toBe('this-week');
    expect(result.label).toBe('Due Fri, Jul 3');
  });

  it('keeps a date after the displayed week as later', () => {
    const result = fmtDueLabel('2026-07-20', rangeEnd, now);
    expect(result.tier).toBe('later');
  });

  it('returns none when there is no due date', () => {
    const result = fmtDueLabel(null, rangeEnd, now);
    expect(result).toEqual({ label: 'No due date', tier: 'none' });
  });

  it('defaults `now` to the real current date when omitted', () => {
    // Just confirm it doesn't throw and returns a valid tier — we can't
    // assert an exact value without controlling wall-clock time.
    const result = fmtDueLabel('2020-01-01', rangeEnd);
    expect(result.tier).toBe('overdue');
  });
});
