// Calendar-aware recording (#253) at the IPC boundary: the opt-in setting is
// the only thing that asks for access, the status channel calls nothing while
// off, and attendee names reach speaker review as suggestions only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIpcHandlers, type IpcServices } from './handlers.js';
import { ArtifactCache } from '../library/artifact-cache.js';
import { openDb } from '../storage/db.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { SettingsRepo } from '../storage/settings-repo.js';
import { CalendarService, type CalendarRunner } from '../calendar/service.js';
import { calendarCandidates } from '../speakers/calendar-candidates.js';
import type Database from 'better-sqlite3';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
let root: string, db: Database.Database, settings: SettingsRepo, meetings: MeetingsRepo, speakers: SpeakersRepo;
let runner: ReturnType<typeof vi.fn<CalendarRunner>>, handlers: Map<string, Handler>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-calendar-ipc-'));
  db = openDb(path.join(root, 'db.sqlite'));
  settings = new SettingsRepo(db); meetings = new MeetingsRepo(db); speakers = new SpeakersRepo(db);
  runner = vi.fn<CalendarRunner>(async (args) => ({ stdout: JSON.stringify({ status: args[1] === 'request' ? 'fullAccess' : 'notDetermined' }) }));
  handlers = new Map();
  const services = {
    meetings, speakers, settings, libraryRoot: root, helperPath: '/bin/meeting-notes-tap',
    calendar: new CalendarService({ helperPath: '/bin/meeting-notes-tap', enabled: () => settings.get('calendarAware'), runner }),
    secrets: { write: vi.fn() },
    actionItems: { listByMeeting: () => [] },
    lmStudio: { listModels: async () => [] },
    recordingManager: { start: async () => ({ sessionId: 's', outputPath: '/o' }), stop: async () => {}, state: () => 'idle', on: () => {} },
    recordingRecovery: {}, appEnumerator: { list: async () => [] },
    roster: { identifyUnknowns: () => [], suggestionsBatch: () => new Map() },
    pipeline: { enqueue: () => {}, getStatus: () => ({ paused: false, currentId: null, queueLength: 0, queueIds: [] }) },
    exporters: {}, artifactCache: new ArtifactCache(),
    llmSupervisor: { ensureReady: async () => {}, ensureServerUp: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} }, gateNotified: new Set<string>(),
  } as unknown as IpcServices;
  registerIpcHandlers({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler), on: () => {} } as unknown as IpcMain, services);
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

describe('calendar setting and status', () => {
  it('reports off and calls nothing while the setting is off', async () => {
    expect(await invoke('calendar:status')).toEqual({ enabled: false, state: 'off' });
    await invoke('settings:set', 'calendarAware', false);
    expect(runner).toHaveBeenCalledTimes(0);
  });
  it('asks for access only when the setting is turned on', async () => {
    expect(await invoke('settings:set', 'calendarAware', true)).toBe(true);
    expect(runner.mock.calls.map(([args]) => args)).toEqual([['calendar', 'request']]);
    expect(settings.get('calendarAware')).toBe(true);
    expect(await invoke('calendar:status')).toEqual({ enabled: true, state: 'notDetermined' });
    expect(runner.mock.calls.map(([args]) => args[1])).toEqual(['request', 'status']);
  });
  it('rejects a non-boolean value', () => {
    expect(() => invoke('settings:set', 'calendarAware', 'yes')).toThrow();
    expect(runner).toHaveBeenCalledTimes(0);
  });
});

describe('attendee names in speaker review', () => {
  beforeEach(() => {
    meetings.insert({ id: 'm', slug: 'm', title: 'Sync', audioPath: '/synthetic.m4a', startedAt: null, durationS: 60, status: 'done', pipelineStage: 'done' });
    const folder = path.join(root, 'meetings', 'm');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'diarization.json'), JSON.stringify({ segments: [
      { start: 0, end: 5, speaker: 'SPEAKER_00' }, { start: 5, end: 9, speaker: 'SPEAKER_01' }] }));
    meetings.setCalendarEvent('m', { title: 'Sync', start: '2026-11-23T15:00:00.000Z', end: '2026-11-23T15:30:00.000Z',
      attendees: ['Ada Lovelace', 'Alan Turing', 'Grace Hopper'], seriesId: null });
    speakers.linkToMeeting('m', 'SPEAKER_00', null, 0);
    speakers.linkToMeeting('m', 'SPEAKER_01', null, 0);
  });

  it('offers attendee names as candidates and assigns nothing', async () => {
    settings.set('calendarAware', true);
    const alan = speakers.create({ displayName: 'alan turing' });
    const grace = speakers.create({ displayName: 'Grace Hopper' });
    speakers.linkToMeeting('m', 'SPEAKER_01', grace, 1);
    const review = await invoke('speakers:review', 'm') as { label: string; calendarSuggestions: unknown[] }[];
    expect(review).toHaveLength(2);
    for (const voice of review) expect(voice.calendarSuggestions).toEqual([
      { displayName: 'Ada Lovelace', rosterId: null }, { displayName: 'Alan Turing', rosterId: alan }]);
    const links = speakers.listForMeeting('m');
    expect(links.find(l => l.localLabel === 'SPEAKER_00')?.rosterSpeakerId).toBeNull();
    expect(speakers.list().map(s => s.displayName).sort()).toEqual(['Grace Hopper', 'alan turing']);
    expect(runner).toHaveBeenCalledTimes(0);
  });

  it('offers nothing while the setting is off', async () => {
    const review = await invoke('speakers:review', 'm') as { calendarSuggestions: unknown[] }[];
    expect(review.every(v => v.calendarSuggestions.length === 0)).toBe(true);
    expect(runner).toHaveBeenCalledTimes(0);
  });
});

it('calendarCandidates skips addresses, duplicates and names already given to a voice', () => {
  expect(calendarCandidates({ attendees: ['Ada', 'ada', 'bob@example.com', 'Cy'], roster: [{ id: 'c', displayName: 'Cy' }], linkedRosterIds: ['c', null] }))
    .toEqual([{ displayName: 'Ada', rosterId: null }]);
});
