import { it, expect, afterEach } from 'vitest';
import { meetingInstant } from './meeting-instant.js';
import { getIsoWeek, isoWeekRange } from './iso-week.js';
const original = process.env.TZ;
afterEach(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});
it.each(['America/New_York', 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Tokyo', 'UTC'])(
  'local week boundaries in %s',
  (zone) => {
    process.env.TZ = zone;
    const sunday = new Date(2026, 3, 26, 21),
      monday = new Date(2026, 3, 27);
    expect(getIsoWeek(sunday)).toEqual({ year: 2026, week: 17 });
    expect(getIsoWeek(monday)).toEqual({ year: 2026, week: 18 });
    const range = isoWeekRange(2026, 17);
    expect(sunday.getTime()).toBeLessThanOrEqual(range.end.getTime());
    expect(range.start.getHours()).toBe(0);
    expect(range.end.getHours()).toBe(23);
    expect(meetingInstant('2026-04-27T00:00:00')).toBe(monday.toISOString());
    expect(meetingInstant('2026-04-27T00:00:00', '/recording-20260427-000000-ab.m4a')).toBe(
      '2026-04-27T00:00:00.000Z',
    );
    expect(meetingInstant('2026-04-27T02:00:00+02:00')).toBe('2026-04-27T00:00:00.000Z');
  },
);
it('uses calendar arithmetic across DST and ISO year boundaries', () => {
  process.env.TZ = 'America/New_York';
  const spring = isoWeekRange(2026, 10);
  expect(spring.end.getTime() - spring.start.getTime() + 1).toBe(167 * 3600000);
  const fall = isoWeekRange(2026, 44);
  expect(fall.end.getTime() - fall.start.getTime() + 1).toBe(169 * 3600000);
  expect(getIsoWeek(new Date(2027, 0, 3, 23))).toEqual({ year: 2026, week: 53 });
  expect(meetingInstant('2026-02-31T12:00:00')).toBeNull();
});
