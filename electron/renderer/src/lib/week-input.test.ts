import { describe, it, expect } from 'vitest';
import {
  isoWeeksInYear,
  weekToInputValue,
  parseWeekInput,
  compareIsoWeeks,
} from './week-input';

describe('isoWeeksInYear', () => {
  it('knows the 53-week years', () => {
    expect(isoWeeksInYear(2015)).toBe(53); // starts Thursday
    expect(isoWeeksInYear(2020)).toBe(53); // leap, starts Wednesday
    expect(isoWeeksInYear(2026)).toBe(53); // starts Thursday
  });

  it('and the 52-week years', () => {
    expect(isoWeeksInYear(2024)).toBe(52);
    expect(isoWeeksInYear(2025)).toBe(52);
    expect(isoWeeksInYear(2027)).toBe(52);
  });
});

describe('weekToInputValue', () => {
  it('zero-pads the week number', () => {
    expect(weekToInputValue({ year: 2026, week: 1 })).toBe('2026-W01');
    expect(weekToInputValue({ year: 2026, week: 7 })).toBe('2026-W07');
    expect(weekToInputValue({ year: 2025, week: 52 })).toBe('2025-W52');
  });
});

describe('parseWeekInput', () => {
  it('round-trips year-boundary weeks', () => {
    // First week of a year…
    expect(parseWeekInput('2026-W01')).toEqual({ year: 2026, week: 1 });
    // …and the 53rd week of a year that actually has one.
    expect(parseWeekInput('2026-W53')).toEqual({ year: 2026, week: 53 });
    expect(parseWeekInput(weekToInputValue({ year: 2025, week: 52 })))
      .toEqual({ year: 2025, week: 52 });
  });

  it('rejects week 53 in a 52-week year', () => {
    // 2025 has only 52 ISO weeks — "2025-W53" is well-formed but not a
    // real week.
    expect(parseWeekInput('2025-W53')).toBeNull();
  });

  it('rejects malformed and out-of-range input', () => {
    expect(parseWeekInput('')).toBeNull();
    expect(parseWeekInput('2026')).toBeNull();
    expect(parseWeekInput('2026-07')).toBeNull();
    expect(parseWeekInput('2026-W00')).toBeNull();
    expect(parseWeekInput('2026-W54')).toBeNull();
    expect(parseWeekInput('2026-W7')).toBeNull(); // input always pads
    expect(parseWeekInput('26-W07')).toBeNull();
    expect(parseWeekInput('garbage')).toBeNull();
    expect(parseWeekInput('1969-W01')).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseWeekInput(' 2026-W02 ')).toEqual({ year: 2026, week: 2 });
  });
});

describe('compareIsoWeeks', () => {
  it('orders across a year boundary', () => {
    expect(compareIsoWeeks({ year: 2025, week: 52 }, { year: 2026, week: 1 })).toBeLessThan(0);
    expect(compareIsoWeeks({ year: 2026, week: 1 }, { year: 2025, week: 52 })).toBeGreaterThan(0);
  });

  it('orders within a year and detects equality', () => {
    expect(compareIsoWeeks({ year: 2026, week: 3 }, { year: 2026, week: 10 })).toBeLessThan(0);
    expect(compareIsoWeeks({ year: 2026, week: 10 }, { year: 2026, week: 10 })).toBe(0);
  });
});
