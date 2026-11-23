import { expect, it, vi } from 'vitest';
vi.mock('../permissions/audio.js', () => ({ getMicAccessStatus: () => 'granted' }));
import os from 'node:os';
import { setupHealth } from './setup-health.js';
import type { IpcServices } from './handlers.js';
import { CalendarService, type CalendarRunner } from '../calendar/service.js';

function services(transcriptionEngine: string, native: Record<string, unknown>, calendarAware = false) {
  return { helperPath: '/missing', libraryRoot: os.tmpdir(), nativeSpeech: { snapshot: () => ({ supported: true, ...native }) },
    settings: { get: (key: string) => key === 'calendarAware' ? calendarAware : undefined,
      getAll: () => ({ transcriptionEngine, summaryProvider: 'lm-studio', lmStudioUrl: '', llmModel: '', calendarAware }) } } as unknown as IpcServices;
}
async function health(transcriptionEngine: string, native: Record<string, unknown>) {
  const rows = await setupHealth(services(transcriptionEngine, native), new CalendarService({ helperPath: '/missing', enabled: () => false }));
  return rows.find(row => row.label === 'Transcription')!;
}
it('judges transcription readiness by the engine the user selected', async () => {
  expect(await health('apple', { appleReady: true, whisperReady: false })).toMatchObject({ state: 'ready', section: 'Processing' });
  expect((await health('apple', { appleReady: false, whisperReady: true })).state).toBe('check');
  expect(await health('whisperkit', { appleReady: true, whisperReady: false })).toMatchObject({ state: 'check', detail: expect.stringContaining('WhisperKit') });
  expect((await health('whisperkit', { appleReady: false, whisperReady: true })).state).toBe('ready');
});

async function calendarRow(enabled: boolean, status?: string) {
  const runner = vi.fn<CalendarRunner>(async () => ({ stdout: JSON.stringify({ status }) }));
  const rows = await setupHealth(services('apple', {}, enabled), new CalendarService({ helperPath: '/h', enabled: () => enabled, runner }));
  return { row: rows.find(r => r.label === 'Calendar')!, runner };
}
it('shows a Calendar row for off, not asked, denied and granted, and checks nothing while off', async () => {
  const off = await calendarRow(false);
  expect(off.row).toMatchObject({ state: 'optional', section: 'Recording', detail: expect.stringContaining('off') });
  expect(off.runner).toHaveBeenCalledTimes(0);
  expect((await calendarRow(true, 'notDetermined')).row).toMatchObject({ state: 'check', detail: expect.stringContaining('not been asked') });
  for (const denied of ['denied', 'restricted', 'writeOnly'])
    expect((await calendarRow(true, denied)).row).toMatchObject({ state: 'check', detail: expect.stringContaining('System Settings') });
  const granted = await calendarRow(true, 'fullAccess');
  expect(granted.row).toMatchObject({ state: 'ready', detail: expect.stringContaining('granted') });
  expect(granted.runner.mock.calls.map(([args]) => args)).toEqual([['calendar', 'status']]);
});
it('builds the calendar check from the setting when none is given, so off spawns nothing', async () => {
  const rows = await setupHealth(services('apple', {}, false));
  expect(rows.find(r => r.label === 'Calendar')?.state).toBe('optional');
});
