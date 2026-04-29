import { describe, it, expect } from 'vitest';
import { getIsoWeek, isoWeekRange, addWeeks, compareIsoWeek, formatWeekRange } from './iso-week.js';

describe('getIsoWeek', () => {
  it('matches known canonical examples', () => {
    // Wikipedia ISO 8601 worked examples:
    // 2005-01-01 (Sat) is in 2004-W53.
    expect(getIsoWeek(new Date('2005-01-01T12:00:00Z'))).toEqual({ year: 2004, week: 53 });
    // 2005-01-02 (Sun) still in 2004-W53.
    expect(getIsoWeek(new Date('2005-01-02T12:00:00Z'))).toEqual({ year: 2004, week: 53 });
    // 2005-01-03 (Mon) is start of 2005-W01.
    expect(getIsoWeek(new Date('2005-01-03T12:00:00Z'))).toEqual({ year: 2005, week: 1 });
    // 2007-12-31 (Mon) is in 2008-W01 — first week of next ISO year.
    expect(getIsoWeek(new Date('2007-12-31T12:00:00Z'))).toEqual({ year: 2008, week: 1 });
    // 2008-12-29 (Mon) is in 2009-W01.
    expect(getIsoWeek(new Date('2008-12-29T12:00:00Z'))).toEqual({ year: 2009, week: 1 });
    // 2009-12-31 (Thu) is in 2009-W53.
    expect(getIsoWeek(new Date('2009-12-31T12:00:00Z'))).toEqual({ year: 2009, week: 53 });
  });

  it('mid-year dates pick the obvious week', () => {
    // 2026-04-22 (Wed) — ISO week 17 of 2026.
    expect(getIsoWeek(new Date('2026-04-22T12:00:00Z'))).toEqual({ year: 2026, week: 17 });
  });
});

describe('isoWeekRange', () => {
  it('returns Monday 00:00 to Sunday 23:59:59.999', () => {
    const { start, end } = isoWeekRange(2026, 17);
    expect(start.toISOString()).toBe('2026-04-20T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-04-26T23:59:59.999Z');
  });

  it('handles week 1 of an ISO year that starts in late Dec', () => {
    // 2008-W01 starts 2007-12-31 (Mon).
    const { start } = isoWeekRange(2008, 1);
    expect(start.toISOString()).toBe('2007-12-31T00:00:00.000Z');
  });
});

describe('addWeeks', () => {
  it('moves forward and back across a year boundary', () => {
    expect(addWeeks({ year: 2026, week: 1 }, -1)).toEqual({ year: 2025, week: 52 });
    expect(addWeeks({ year: 2025, week: 52 }, 2)).toEqual({ year: 2026, week: 2 });
  });

  it('idempotent for delta=0', () => {
    expect(addWeeks({ year: 2026, week: 17 }, 0)).toEqual({ year: 2026, week: 17 });
  });
});

describe('compareIsoWeek', () => {
  it('orders by (year, week)', () => {
    expect(compareIsoWeek({ year: 2026, week: 17 }, { year: 2026, week: 17 })).toBe(0);
    expect(compareIsoWeek({ year: 2026, week: 17 }, { year: 2026, week: 18 })).toBe(-1);
    expect(compareIsoWeek({ year: 2027, week: 1 }, { year: 2026, week: 53 })).toBe(1);
  });
});

describe('formatWeekRange', () => {
  it('formats a same-month range', () => {
    expect(formatWeekRange(2026, 17)).toMatch(/Apr.*2026/);
  });
});
