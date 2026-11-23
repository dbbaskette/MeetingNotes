import { describe, expect, it, vi } from 'vitest';
import { CalendarService, cleanAttendees, pickEventAt, type CalendarRunner, type HelperCalendarEvent } from './service.js';

const NOW = new Date('2026-11-23T15:10:00.000Z');
const ev = (over: Partial<HelperCalendarEvent>): HelperCalendarEvent => ({
  title: 'Weekly sync', start: '2026-11-23T15:00:00Z', end: '2026-11-23T15:30:00Z',
  attendees: [], seriesId: null, allDay: false, declined: false, ...over,
});

function fakeRunner(responses: Record<string, string | Error>) {
  return vi.fn<CalendarRunner>(async (args) => {
    const r = responses[args[1]!];
    if (r instanceof Error) throw r;
    if (r === undefined) throw new Error(`unexpected ${args.join(' ')}`);
    return { stdout: r };
  });
}

describe('pickEventAt', () => {
  it('skips all-day events and events the user declined', () => {
    expect(pickEventAt([ev({ allDay: true, start: '2026-11-23T00:00:00Z', end: '2026-11-24T00:00:00Z' })], NOW)).toBeNull();
    expect(pickEventAt([ev({ declined: true })], NOW)).toBeNull();
    expect(pickEventAt([ev({ allDay: true, title: 'Holiday' }), ev({ title: 'Real' })], NOW)?.title).toBe('Real');
  });
  it('prefers the overlapping event whose start is closest to now', () => {
    const picked = pickEventAt([
      ev({ title: 'Long block', start: '2026-11-23T13:00:00Z', end: '2026-11-23T17:00:00Z' }),
      ev({ title: 'Standup', start: '2026-11-23T15:05:00Z', end: '2026-11-23T15:20:00Z' }),
      ev({ title: 'Earlier', start: '2026-11-23T14:30:00Z', end: '2026-11-23T15:30:00Z' }),
    ], NOW);
    expect(picked?.title).toBe('Standup');
  });
  it('counts an event that starts within the lead window, but not one that ended or is far off', () => {
    expect(pickEventAt([ev({ title: 'Soon', start: '2026-11-23T15:13:00Z', end: '2026-11-23T16:00:00Z' })], NOW)?.title).toBe('Soon');
    expect(pickEventAt([ev({ start: '2026-11-23T15:40:00Z', end: '2026-11-23T16:00:00Z' })], NOW)).toBeNull();
    expect(pickEventAt([ev({ start: '2026-11-23T14:00:00Z', end: '2026-11-23T15:10:00Z' })], NOW)).toBeNull();
  });
  it('returns null when nothing overlaps', () => {
    expect(pickEventAt([], NOW)).toBeNull();
  });
  it('keeps display names only, never an e-mail address', () => {
    const picked = pickEventAt([ev({ attendees: ['Ada Lovelace', 'grace@example.com', 'ada lovelace', ' Alan  Turing '], seriesId: 'S1' })], NOW);
    expect(picked).toEqual({ title: 'Weekly sync', start: '2026-11-23T15:00:00.000Z', end: '2026-11-23T15:30:00.000Z', attendees: ['Ada Lovelace', 'Alan Turing'], seriesId: 'S1' });
    expect(JSON.stringify(picked)).not.toContain('@');
    expect(cleanAttendees(['Bob <bob@example.com>'])).toEqual([]);
  });
});

describe('CalendarService', () => {
  it('with the setting off never invokes the runner, for status, request or lookup', async () => {
    const runner = fakeRunner({});
    const svc = new CalendarService({ helperPath: '/h', enabled: () => false, runner });
    expect(await svc.status()).toBe('off');
    expect(await svc.requestAccess()).toBe('off');
    expect(await svc.eventAt(NOW)).toBeNull();
    expect(runner).toHaveBeenCalledTimes(0);
  });
  it('does not ask for events when access is not granted', async () => {
    for (const status of ['notDetermined', 'denied', 'restricted', 'writeOnly']) {
      const runner = fakeRunner({ status: JSON.stringify({ status }) });
      const svc = new CalendarService({ helperPath: '/h', enabled: () => true, runner });
      expect(await svc.eventAt(NOW)).toBeNull();
      expect(runner.mock.calls.map(([args]) => args[1])).toEqual(['status']);
    }
  });
  it('status never asks for access', async () => {
    const runner = fakeRunner({ status: '{"status":"denied"}\n' });
    const svc = new CalendarService({ helperPath: '/h', enabled: () => true, runner });
    expect(await svc.status()).toBe('denied');
    expect(runner.mock.calls.every(([args]) => args[1] === 'status')).toBe(true);
  });
  it('looks up the event happening now with full access', async () => {
    const runner = fakeRunner({
      status: '{"status":"fullAccess"}',
      events: JSON.stringify({ events: [ev({ title: 'Design review', attendees: ['Ada', 'ada@example.com'] })] }),
    });
    const svc = new CalendarService({ helperPath: '/h', enabled: () => true, runner });
    expect(await svc.eventAt(NOW)).toMatchObject({ title: 'Design review', attendees: ['Ada'] });
    expect(runner.mock.calls[1]![0]).toEqual(['calendar', 'events', '--from', NOW.toISOString(), '--to', '2026-11-23T15:15:00.000Z']);
  });
  it('treats a failing or garbled helper as no event and never logs titles or names', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const failing = Object.assign(new Error('Command failed: Secret Board Meeting'), { code: 3, stdout: '{"error":"no-access","status":"denied"}' });
    for (const events of [failing, 'not json', JSON.stringify({ events: [ev({ title: 'Secret Board Meeting', attendees: ['Ada'] })] })]) {
      const svc = new CalendarService({ helperPath: '/h', enabled: () => true, logger,
        runner: fakeRunner({ status: '{"status":"fullAccess"}', events }) });
      await svc.eventAt(NOW);
    }
    expect(await new CalendarService({ helperPath: '/h', enabled: () => true, runner: fakeRunner({ status: new Error('ENOENT') }) }).status()).toBe('unavailable');
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(logged).not.toMatch(/Secret|Board|Ada/);
    expect(logged).toContain('"attendees":1');
  });
});
