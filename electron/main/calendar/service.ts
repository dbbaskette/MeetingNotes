// electron/main/calendar/service.ts
//
// Calendar-aware recording (#253). A thin, read-only wrapper around the
// capture helper's `calendar` subcommand (EventKit). Opt-in: while the
// `calendarAware` setting is off nothing here spawns the helper, so no
// calendar API is ever called. Nothing leaves the Mac, and event titles and
// attendee names are never logged (counts only).
import { execFile } from 'node:child_process';
import { z } from 'zod';

export type CalendarAccess = 'notDetermined' | 'denied' | 'restricted' | 'fullAccess' | 'writeOnly';
/** `off`: the setting is off (nothing was asked). `unavailable`: the helper
 *  is missing or failed, so the state is unknown. */
export type CalendarState = CalendarAccess | 'off' | 'unavailable';

/** What is kept for a meeting: no e-mail addresses, display names only. */
export interface CalendarEventSnapshot {
  title: string;
  start: string;
  end: string;
  attendees: string[];
  seriesId: string | null;
}

export const CalendarEventSnapshotSchema = z.object({
  title: z.string().max(500),
  start: z.string().max(64),
  end: z.string().max(64),
  attendees: z.array(z.string().max(200)).max(500),
  seriesId: z.string().max(500).nullable(),
}).strict();

const ACCESS = ['notDetermined', 'denied', 'restricted', 'fullAccess', 'writeOnly'] as const;
const StatusOutput = z.object({ status: z.enum(ACCESS) });
const HelperEvent = z.object({
  title: z.string().catch(''),
  start: z.string(),
  end: z.string(),
  attendees: z.array(z.string()).catch([]),
  seriesId: z.string().nullable().catch(null),
  allDay: z.boolean().catch(false),
  declined: z.boolean().catch(false),
});
export type HelperCalendarEvent = z.infer<typeof HelperEvent>;
const EventsOutput = z.object({ events: z.array(z.unknown()) });

/** Runs the helper with `args`. Rejects on a non-zero exit, with `stdout`
 *  on the error when there was any (as `execFile` does). */
export type CalendarRunner = (args: string[], opts: { timeoutMs: number }) => Promise<{ stdout: string }>;

/** A recording that starts this long before an event still counts as that
 *  event: people often press Record a minute or two early. */
export const EVENT_LEAD_MS = 5 * 60_000;
// Kept short: a recording waits for the lookup before it starts.
const STATUS_TIMEOUT_MS = 2_000;
const EVENTS_TIMEOUT_MS = 3_000;
/** The permission dialog waits for the user. */
const REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface CalendarLog { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void }

export class CalendarService {
  constructor(private readonly deps: {
    helperPath: string;
    /** Read on every call so turning the setting off takes effect at once. */
    enabled: () => boolean;
    runner?: CalendarRunner;
    clock?: () => Date;
    logger?: CalendarLog;
  }) {}

  private run(args: string[], timeoutMs: number): Promise<{ stdout: string }> {
    const runner = this.deps.runner ?? defaultRunner(this.deps.helperPath);
    return runner(['calendar', ...args], { timeoutMs });
  }

  /** Current permission state. Never prompts. `off` without spawning anything. */
  async status(): Promise<CalendarState> {
    if (!this.deps.enabled()) return 'off';
    try {
      return parseStatus((await this.run(['status'], STATUS_TIMEOUT_MS)).stdout) ?? 'unavailable';
    } catch (error) {
      this.deps.logger?.warn('calendar:status-failed', { reason: reasonOf(error) });
      return 'unavailable';
    }
  }

  /** Shows the macOS permission dialog when access was never asked. Called
   *  only when the user turns the setting on in Settings. */
  async requestAccess(): Promise<CalendarState> {
    if (!this.deps.enabled()) return 'off';
    try {
      const state = parseStatus((await this.run(['request'], REQUEST_TIMEOUT_MS)).stdout) ?? 'unavailable';
      this.deps.logger?.info('calendar:access-requested', { state });
      return state;
    } catch (error) {
      this.deps.logger?.warn('calendar:request-failed', { reason: reasonOf(error) });
      return 'unavailable';
    }
  }

  /** The event happening at `now` (see pickEventAt), or null. Returns null
   *  without calling anything when the setting is off, and without asking
   *  for events when access is not granted. Never throws. */
  async eventAt(now: Date = this.deps.clock?.() ?? new Date()): Promise<CalendarEventSnapshot | null> {
    if (!this.deps.enabled()) return null;
    if (await this.status() !== 'fullAccess') return null;
    try {
      const from = new Date(now.getTime()).toISOString();
      const to = new Date(now.getTime() + EVENT_LEAD_MS).toISOString();
      const { stdout } = await this.run(['events', '--from', from, '--to', to], EVENTS_TIMEOUT_MS);
      const events = parseEvents(stdout);
      const picked = pickEventAt(events, now);
      this.deps.logger?.info('calendar:lookup', { events: events.length, matched: picked ? 1 : 0, attendees: picked?.attendees.length ?? 0 });
      return picked;
    } catch (error) {
      this.deps.logger?.warn('calendar:lookup-failed', { reason: reasonOf(error) });
      return null;
    }
  }
}

/** The service as the IPC handlers see it: built from the shared services,
 *  reading the `calendarAware` setting on every call. Stateless, so one per
 *  use is fine; `calendar` lets a caller supply its own (tests). */
export function calendarFromServices(s: {
  helperPath: string;
  settings: { get(key: 'calendarAware'): boolean };
  logger?: CalendarLog;
  calendar?: CalendarService;
}): CalendarService {
  return s.calendar ?? new CalendarService({ helperPath: s.helperPath, enabled: () => s.settings.get('calendarAware'), logger: s.logger });
}

function defaultRunner(helperPath: string): CalendarRunner {
  return (args, { timeoutMs }) => new Promise((resolve, reject) => {
    execFile(helperPath, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(Object.assign(error, { stdout: String(stdout ?? '') }));
      else resolve({ stdout: String(stdout) });
    });
  });
}

function lastJsonLine(stdout: string): unknown {
  const line = stdout.split('\n').map(l => l.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  try { return JSON.parse(line) as unknown; } catch { return null; }
}

export function parseStatus(stdout: string): CalendarAccess | null {
  const parsed = StatusOutput.safeParse(lastJsonLine(stdout));
  return parsed.success ? parsed.data.status : null;
}

export function parseEvents(stdout: string): HelperCalendarEvent[] {
  const parsed = EventsOutput.safeParse(lastJsonLine(stdout));
  if (!parsed.success) throw new Error('malformed-events');
  return parsed.data.events.flatMap((raw) => {
    const event = HelperEvent.safeParse(raw);
    return event.success ? [event.data] : [];
  });
}

/** The event a recording starting at `now` belongs to: all-day and declined
 *  events are skipped; an event counts when it is under way or starts within
 *  `leadMs`; of several, the one whose start is closest to `now` wins. */
export function pickEventAt(events: readonly HelperCalendarEvent[], now: Date, leadMs = EVENT_LEAD_MS): CalendarEventSnapshot | null {
  const t = now.getTime();
  let best: { event: HelperCalendarEvent; distance: number } | null = null;
  for (const event of events) {
    if (event.allDay || event.declined) continue;
    const start = Date.parse(event.start), end = Date.parse(event.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (!(start - leadMs <= t && t < end)) continue;
    const distance = Math.abs(start - t);
    if (!best || distance < best.distance) best = { event, distance };
  }
  if (!best) return null;
  const { event } = best;
  return {
    title: cleanTitle(event.title),
    start: new Date(Date.parse(event.start)).toISOString(),
    end: new Date(Date.parse(event.end)).toISOString(),
    attendees: cleanAttendees(event.attendees),
    seriesId: event.seriesId ? event.seriesId.slice(0, 500) : null,
  };
}

/** One line, at most 200 characters: usable as a recording title. */
export function cleanTitle(value: string): string {
  return [...value].map(c => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('')
    .replace(/\s+/g, ' ').trim().slice(0, 200).trim();
}

/** Display names only: anything that looks like an e-mail address is
 *  dropped, duplicates are removed. */
export function cleanAttendees(names: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = cleanTitle(raw);
    if (!name || name.includes('@')) continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 200) break;
  }
  return out;
}

/** A failure reason safe to log: never helper output, which can hold titles. */
function reasonOf(error: unknown): string {
  const e = error as { code?: unknown; killed?: boolean; message?: string; stdout?: string };
  if (e?.killed) return 'timeout';
  const helperError = (lastJsonLine(e?.stdout ?? '') as { error?: unknown } | null)?.error;
  if (typeof helperError === 'string' && /^[a-z-]{1,40}$/.test(helperError)) return helperError;
  if (typeof e?.code === 'string' && /^[A-Z_]{1,40}$/.test(e.code)) return e.code;
  if (typeof e?.code === 'number') return `exit-${e.code}`;
  if (e?.message === 'malformed-events') return 'malformed-events';
  return 'failed';
}
