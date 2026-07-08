// electron/renderer/src/lib/week-input.ts
//
// Two-way conversion between the WeeklyView's ISO week state
// ({ year, week }) and the `YYYY-Www` string format used by
// <input type="week"> (e.g. "2026-W07"). Pure so it can be unit-tested
// without a DOM harness; the ISO week-count rule mirrors
// electron/main/lib/iso-week.ts (main/renderer module boundary — the
// string format is the contract).

export interface IsoWeekValue {
  year: number;
  week: number;
}

/** Number of ISO weeks in a year: 53 when the year starts on a Thursday,
 *  or is a leap year starting on a Wednesday; 52 otherwise. (Standard
 *  ISO-8601 rule — e.g. 2026 has 53 weeks, 2025 has 52.) */
export function isoWeeksInYear(year: number): number {
  const jan1Dow = new Date(Date.UTC(year, 0, 1)).getUTCDay(); // 0=Sun..6=Sat
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return jan1Dow === 4 || (leap && jan1Dow === 3) ? 53 : 52;
}

/** Format a week for <input type="week">'s value: "YYYY-Www", week
 *  zero-padded to two digits. */
export function weekToInputValue(w: IsoWeekValue): string {
  return `${String(w.year).padStart(4, '0')}-W${String(w.week).padStart(2, '0')}`;
}

/** Parse an <input type="week"> value back into { year, week }.
 *  Returns null for anything malformed or out of range — including a
 *  well-formed week number the year doesn't have (e.g. 2025-W53; 2025
 *  only has 52 ISO weeks). */
export function parseWeekInput(value: string): IsoWeekValue | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (year < 1970 || year > 9999) return null;
  if (week < 1 || week > isoWeeksInYear(year)) return null;
  return { year, week };
}

/** Chronological comparison: negative when a is before b, 0 when equal,
 *  positive when after. Used to clamp picker jumps to the current week. */
export function compareIsoWeeks(a: IsoWeekValue, b: IsoWeekValue): number {
  return a.year !== b.year ? a.year - b.year : a.week - b.week;
}
