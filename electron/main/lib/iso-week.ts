// electron/main/lib/iso-week.ts
//
// ISO-8601 week numbering. Used by the weekly-summary feature to
// label and group meetings into Monday-start weeks. JavaScript
// doesn't have this built-in, so we implement the standard algorithm.
//
// Reference: https://en.wikipedia.org/wiki/ISO_week_date#Calculating_the_week_number_from_an_ordinal_date
// Tested against the dates Wikipedia lists in the worked-example table.

export interface IsoWeek {
  year: number;
  week: number;
}

/** Returns the ISO year/week for a given Date.
 *  ISO weeks start on Monday and the year of week 1 is determined
 *  by which calendar year contains the Thursday of that week. */
export function getIsoWeek(d: Date): IsoWeek {
  // Use UTC throughout to avoid local-timezone offsets pushing edge
  // dates into the wrong week. Critical: take UTC components from
  // the input, not local — a UTC midnight Date is the previous
  // day's afternoon in negative-offset timezones.
  const target = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
  ));
  // Set target to Thursday of the same ISO week — this is the
  // canonical anchor day. Day-of-week 1=Mon..7=Sun in ISO.
  const dow = (target.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  target.setUTCDate(target.getUTCDate() - dow + 3); // Thursday
  // Year of that Thursday is the ISO year.
  const isoYear = target.getUTCFullYear();
  // Week number = days since Jan 4 of isoYear / 7, +1.
  // (Jan 4 is always in week 1.)
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Thursday = new Date(jan4);
  week1Thursday.setUTCDate(jan4.getUTCDate() - jan4Dow + 3);
  const diffMs = target.getTime() - week1Thursday.getTime();
  const week = 1 + Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
  return { year: isoYear, week };
}

/** Inclusive Monday 00:00 → Sunday 23:59:59.999 in UTC for a given
 *  ISO year/week. */
export function isoWeekRange(year: number, week: number): { start: Date; end: Date } {
  // Monday of week 1 is the Monday on or before Jan 4.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const start = new Date(week1Monday);
  start.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
  return { start, end };
}

/** Add or subtract weeks. Handles year boundaries (week 52 of one
 *  year ↔ week 1 of the next) by going through Date arithmetic. */
export function addWeeks(input: IsoWeek, deltaWeeks: number): IsoWeek {
  const { start } = isoWeekRange(input.year, input.week);
  const shifted = new Date(start);
  shifted.setUTCDate(start.getUTCDate() + deltaWeeks * 7);
  return getIsoWeek(shifted);
}

/** Quick comparison: a > b? a < b? a === b? Returns -1/0/1. */
export function compareIsoWeek(a: IsoWeek, b: IsoWeek): number {
  if (a.year !== b.year) return a.year < b.year ? -1 : 1;
  if (a.week !== b.week) return a.week < b.week ? -1 : 1;
  return 0;
}

/** Human label for the week, e.g. "Apr 21 – 25, 2026" (Mon–Fri). */
export function formatWeekRange(year: number, week: number): string {
  const { start } = isoWeekRange(year, week);
  const monday = new Date(start);
  const friday = new Date(start);
  friday.setUTCDate(start.getUTCDate() + 4);
  const fmt = (d: Date): string => d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  return `${fmt(monday)} – ${fmt(friday).replace(/^[A-Za-z]+ /, (m) => {
    // Strip month name from end-of-range when same as start
    return monday.getUTCMonth() === friday.getUTCMonth() ? '' : m;
  })}, ${year}`;
}
