// Calendar-aware recording (#253) end to end with a fake helper runner: the
// recording manager, the session row, the catalog and the meeting's stored
// calendar event. No real calendar, no real capture.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../storage/db.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { RecordingSessionsRepo } from '../storage/recording-sessions-repo.js';
import { RecordingManager } from '../recording/manager.js';
import { catalogAudio } from '../library/catalog.js';
import { SchemeDispatcher } from '../url-scheme/dispatcher.js';
import { CalendarService, type CalendarEventSnapshot, type CalendarRunner } from './service.js';
import { attachLateCalendarEvent } from './late-event.js';

const NOW = new Date('2026-11-23T15:10:00.000Z');
const EVENT = {
  title: 'Quarterly planning', start: '2026-11-23T15:00:00Z', end: '2026-11-23T16:00:00Z',
  attendees: ['Ada Lovelace', 'grace@example.com', 'Alan Turing'], seriesId: 'series-1', allDay: false, declined: false,
};

function helperProcess(): ChildProcessWithoutNullStreams {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const proc = Object.assign(new EventEmitter(), {
    pid: 4242, stdout, stderr: { on: () => {}, setEncoding: () => {} },
    kill: vi.fn((signal: string) => { if (signal === 'SIGTERM') queueMicrotask(() => proc.emit('exit', 0)); return true; }),
  }) as unknown as ChildProcessWithoutNullStreams;
  queueMicrotask(() => stdout.emit('data', '{"event":"started"}\n'));
  return proc;
}

let dir: string, db: Database.Database, sessions: RecordingSessionsRepo, meetings: MeetingsRepo;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-calendar-'));
  db = openDb(path.join(dir, 'db.sqlite'));
  sessions = new RecordingSessionsRepo(db);
  meetings = new MeetingsRepo(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** Lets pending promise callbacks (a fake lookup that has resolved) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(opts: { enabled: boolean; status?: string; runner?: CalendarRunner; calendarEventAt?: (now: Date) => Promise<CalendarEventSnapshot | null> }) {
  const runner = vi.fn<CalendarRunner>(opts.runner ?? (async (args) => {
    if (args[1] === 'status') return { stdout: JSON.stringify({ status: opts.status ?? 'fullAccess' }) };
    if (args[1] === 'events') return { stdout: JSON.stringify({ events: [EVENT] }) };
    throw new Error(`unexpected ${args.join(' ')}`);
  }));
  const calendar = new CalendarService({ helperPath: '/h', enabled: () => opts.enabled, runner, clock: () => NOW });
  const spawn = vi.fn(() => helperProcess());
  const states: { state: string; reason?: string }[] = [];
  const manager = new RecordingManager({
    helperPath: '/h', recordingsDir: dir, repo: sessions, clock: () => NOW, spawn,
    calendarEventAt: opts.calendarEventAt ?? ((now) => calendar.eventAt(now)),
    onCalendarEvent: (info) => attachLateCalendarEvent(meetings, info),
  });
  manager.on('state-change', (_id, state, reason) => states.push({ state, reason }));
  return { runner, manager, calendar, spawn, states };
}

async function recordAndCatalog(manager: RecordingManager, title?: string) {
  const { sessionId, outputPath } = await manager.start({ targetPid: 'system', targetLabel: 'System Audio', mic: true, title });
  await settle();
  await manager.stop(sessionId);
  return catalogOutput(outputPath);
}
async function catalogOutput(outputPath: string) {
  const result = await catalogAudio(outputPath, {
    meetings, sessions, libraryRoot: dir, probe: async () => ({ durationS: 60 }) as never, createFolder: () => {},
  });
  return meetings.findById(result.meeting.id)!;
}

describe('calendar-aware recording', () => {
  it('with the setting off calls no calendar API and keeps the normal title', async () => {
    const { runner, manager, calendar } = setup({ enabled: false });
    const meeting = await recordAndCatalog(manager);
    expect(runner).toHaveBeenCalledTimes(0);
    expect(meeting.title).not.toBe('Quarterly planning');
    expect(meeting.titleExplicit).toBe(false);
    expect(meetings.calendarEventFor(meeting.id)).toBeNull();
    expect(await calendar.status()).toBe('off');
    expect(runner).toHaveBeenCalledTimes(0);
  });

  it('with access not granted asks for no events and records with the normal title', async () => {
    const { runner, manager } = setup({ enabled: true, status: 'denied' });
    const meeting = await recordAndCatalog(manager);
    expect(runner.mock.calls.map(([args]) => args[1])).toEqual(['status']);
    expect(meeting.titleExplicit).toBe(false);
    expect(meetings.calendarEventFor(meeting.id)).toBeNull();
  });

  it('titles the recording from the overlapping event and keeps the event, without e-mail addresses', async () => {
    const { manager } = setup({ enabled: true });
    const meeting = await recordAndCatalog(manager);
    expect(meeting.title).toBe('Quarterly planning');
    const stored = meetings.calendarEventFor(meeting.id);
    expect(stored).toEqual({ title: 'Quarterly planning', start: '2026-11-23T15:00:00.000Z', end: '2026-11-23T16:00:00.000Z',
      attendees: ['Ada Lovelace', 'Alan Turing'], seriesId: 'series-1' });
    const everything = JSON.stringify([db.prepare('SELECT * FROM meeting_calendar_events').all(), db.prepare('SELECT * FROM recording_sessions').all()]);
    expect(everything).not.toContain('@');
  });

  it('an explicit title from the UI beats the event title, and the event is still kept', async () => {
    const { manager } = setup({ enabled: true });
    const meeting = await recordAndCatalog(manager, 'My own title');
    expect(meeting.title).toBe('My own title');
    expect(meetings.calendarEventFor(meeting.id)?.title).toBe('Quarterly planning');
  });

  it('a URL title= beats the event title', async () => {
    const { manager } = setup({ enabled: true });
    let started: { outputPath: string } | null = null;
    const start = manager.start.bind(manager);
    vi.spyOn(manager, 'start').mockImplementation(async (...args) => { const r = await start(...args); started = r; return r; });
    const dispatcher = new SchemeDispatcher({
      recordingManager: manager, appEnumerator: { list: async () => [] } as never, recordingSessionsRepo: sessions, meetings,
      emitOpenMeeting: () => {}, notify: () => {}, focusMainWindow: () => {}, logger: { info: () => {}, error: () => {} },
    });
    expect((await dispatcher.dispatch('meetingnotes://record?source=system&title=From%20the%20URL')).ok).toBe(true);
    await settle();
    expect(sessions.findOpen()[0]?.title).toBe('From the URL');
    await manager.stop(manager.active()[0]!.sessionId);
    expect((await catalogOutput(started!.outputPath)).title).toBe('From the URL');
  });

  it('a capture test never consults the calendar', async () => {
    const { runner, manager } = setup({ enabled: true });
    const { sessionId } = await manager.start({ targetPid: 'system', targetLabel: 'All', mic: true }, { outputDir: dir, disposable: true });
    await manager.stop(sessionId);
    expect(runner).toHaveBeenCalledTimes(0);
  });

  it('starts capture without waiting for a calendar lookup that never settles', async () => {
    const pending = new Promise<{ stdout: string }>(() => {});
    const { runner, manager, spawn } = setup({ enabled: true, runner: async () => pending });
    const { sessionId } = await manager.start({ targetPid: 'system', targetLabel: 'All', mic: true });
    expect(spawn).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalled();
    expect(manager.state(sessionId)).toBe('recording');
    expect(sessions.findById(sessionId)?.title).toBeNull();
    await manager.stop(sessionId);
  });

  it('applies a late event title to the live recording and announces it', async () => {
    let resolve!: (e: CalendarEventSnapshot | null) => void;
    const { manager, states } = setup({ enabled: true, calendarEventAt: () => new Promise((r) => { resolve = r; }) });
    const { sessionId, outputPath } = await manager.start({ targetPid: 'system', targetLabel: 'All', mic: true });
    expect(manager.active()[0]?.startInput.title).toBeUndefined();
    resolve({ title: 'Late planning', start: EVENT.start, end: EVENT.end, attendees: ['Ada'], seriesId: null });
    await settle();
    expect(sessions.findById(sessionId)).toMatchObject({ title: 'Late planning', calendarEvent: { title: 'Late planning' } });
    expect(manager.active()[0]?.startInput.title).toBe('Late planning');
    expect(states.at(-1)).toEqual({ state: 'recording', reason: 'calendar-title' });
    await manager.stop(sessionId);
    expect((await catalogOutput(outputPath)).title).toBe('Late planning');
  });

  it('never overwrites an explicit title or a rename made before the lookup finished', async () => {
    let resolve!: (e: CalendarEventSnapshot | null) => void;
    const late = () => new Promise<CalendarEventSnapshot | null>((r) => { resolve = r; });
    const event = { title: 'Calendar title', start: EVENT.start, end: EVENT.end, attendees: [], seriesId: null };
    // Explicit title at start.
    const first = setup({ enabled: true, calendarEventAt: late });
    const a = await first.manager.start({ targetPid: 'system', targetLabel: 'All', mic: true, title: 'Typed title' });
    resolve(event); await settle();
    expect(sessions.findById(a.sessionId)?.title).toBe('Typed title');
    expect(sessions.findById(a.sessionId)?.calendarEvent?.title).toBe('Calendar title');
    await first.manager.stop(a.sessionId);
    // Stopped, cataloged and renamed by the user, then the lookup lands.
    const second = setup({ enabled: true, calendarEventAt: late });
    const b = await second.manager.start({ targetPid: 'system', targetLabel: 'All', mic: true });
    await second.manager.stop(b.sessionId);
    const meeting = await catalogOutput(b.outputPath);
    meetings.updateTitle(meeting.id, 'My rename');
    resolve(event); await settle();
    expect(meetings.findById(meeting.id)?.title).toBe('My rename');
    expect(meetings.calendarEventFor(meeting.id)?.title).toBe('Calendar title');
  });

  it('attaches an event that arrives after stop to the meeting, and titles it when nobody named it', async () => {
    let resolve!: (e: CalendarEventSnapshot | null) => void;
    const { manager } = setup({ enabled: true, calendarEventAt: () => new Promise((r) => { resolve = r; }) });
    const { sessionId, outputPath } = await manager.start({ targetPid: 'system', targetLabel: 'All', mic: true });
    await manager.stop(sessionId);
    const meeting = await catalogOutput(outputPath);
    expect(meetings.calendarEventFor(meeting.id)).toBeNull();
    resolve({ title: 'After stop', start: EVENT.start, end: EVENT.end, attendees: ['Ada Lovelace'], seriesId: 's' });
    await settle();
    expect(meetings.calendarEventFor(meeting.id)).toMatchObject({ title: 'After stop', attendees: ['Ada Lovelace'] });
    expect(meetings.findById(meeting.id)).toMatchObject({ title: 'After stop', titleExplicit: true });
  });

  it('a failed or rejected lookup changes nothing and leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      for (const calendarEventAt of [() => Promise.reject(new Error('boom')), () => Promise.resolve(null)]) {
        const { manager } = setup({ enabled: true, calendarEventAt });
        const { sessionId, outputPath } = await manager.start({ targetPid: 'system', targetLabel: 'All', mic: true });
        await settle();
        expect(sessions.findById(sessionId)).toMatchObject({ title: null, calendarEvent: null });
        await manager.stop(sessionId);
        const meeting = await catalogOutput(outputPath);
        expect(meetings.calendarEventFor(meeting.id)).toBeNull();
        expect(meeting.titleExplicit).toBe(false);
      }
      // The database closing under a late lookup (app quitting) is swallowed too.
      let resolve!: (e: CalendarEventSnapshot | null) => void;
      const { manager } = setup({ enabled: true, calendarEventAt: () => new Promise((r) => { resolve = r; }) });
      const { sessionId } = await manager.start({ targetPid: 'system', targetLabel: 'All', mic: true });
      await manager.stop(sessionId);
      db.close();
      resolve({ title: 'Too late', start: EVENT.start, end: EVENT.end, attendees: [], seriesId: null });
      await settle(); await settle();
      db = openDb(path.join(dir, 'db.sqlite'));
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });
});
