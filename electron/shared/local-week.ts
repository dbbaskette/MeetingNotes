/** User-local calendar weeks; bounds are absolute Date instants. */
export interface IsoWeek {
  year: number;
  week: number;
}
export function getIsoWeek(date: Date = new Date()): IsoWeek {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7) + 3);
  const year = day.getUTCFullYear(),
    anchor = new Date(Date.UTC(year, 0, 4));
  anchor.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() + 6) % 7) + 3);
  return { year, week: 1 + Math.round((day.getTime() - anchor.getTime()) / 604800000) };
}
export function isoWeekRange(year: number, week: number): { start: Date; end: Date } {
  const start = new Date(year, 0, 4);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) + (week - 1) * 7);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  end.setMilliseconds(-1);
  return { start, end };
}
export function addWeeks(input: IsoWeek, delta: number): IsoWeek {
  const { start } = isoWeekRange(input.year, input.week);
  start.setDate(start.getDate() + delta * 7);
  return getIsoWeek(start);
}
export function compareIsoWeek(a: IsoWeek, b: IsoWeek): number {
  return a.year === b.year ? Math.sign(a.week - b.week) : Math.sign(a.year - b.year);
}
export function formatWeekRange(year: number, week: number): string {
  const { start } = isoWeekRange(year, week),
    friday = new Date(start);
  friday.setDate(start.getDate() + 4);
  const format = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${format(start)} – ${format(friday)}, ${start.getFullYear()}`;
}
