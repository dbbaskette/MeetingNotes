import path from 'node:path';
import { validCalendarDate } from '../../shared/calendar-date.js';
/** Read legacy naive imports locally, built-in filename clocks in UTC.
 * Explicit offsets win; no legacy recording or timestamp row is rewritten. */
export function meetingInstant(value: string | null | undefined, audioPath = ''): string | null {
  if (!value) return null;
  if (!validCalendarDate(value.slice(0, 10))) return null;
  const naive = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  let date: Date;
  if (naive && !/^recording-\d{8}-\d{6}(?:-|\.)/.test(path.basename(audioPath))) {
    const [, y, m, d, h, min, sec, ms] = naive;
    date = new Date(+y!, +m! - 1, +d!, +h!, +min!, +sec!, +(ms ?? '').padEnd(3, '0'));
    // Reject calendar overflow. Native DST gap/overlap interpretation is
    // necessary where historical wall clocks contain no recoverable offset.
    if (
      date.getFullYear() !== +y! ||
      date.getMonth() !== +m! - 1 ||
      date.getDate() !== +d! ||
      +h! > 23 ||
      +min! > 59 ||
      +sec! > 59
    )
      return null;
  } else date = new Date(naive ? `${value}Z` : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
