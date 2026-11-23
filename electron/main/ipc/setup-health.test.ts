import { expect, it, vi } from 'vitest';
vi.mock('../permissions/audio.js', () => ({ getMicAccessStatus: () => 'granted' }));
import os from 'node:os';
import { setupHealth } from './setup-health.js';
import type { IpcServices } from './handlers.js';

function health(transcriptionEngine: string, native: Record<string, unknown>) {
  const rows = setupHealth({ helperPath: '/missing', libraryRoot: os.tmpdir(), nativeSpeech: { snapshot: () => ({ supported: true, ...native }) },
    settings: { getAll: () => ({ transcriptionEngine, summaryProvider: 'lm-studio', lmStudioUrl: '', llmModel: '' }) } } as unknown as IpcServices);
  return rows.find(row => row.label === 'Transcription')!;
}
it('judges transcription readiness by the engine the user selected', () => {
  expect(health('apple', { appleReady: true, whisperReady: false })).toMatchObject({ state: 'ready', section: 'Processing' });
  expect(health('apple', { appleReady: false, whisperReady: true }).state).toBe('check');
  expect(health('whisperkit', { appleReady: true, whisperReady: false })).toMatchObject({ state: 'check', detail: expect.stringContaining('WhisperKit') });
  expect(health('whisperkit', { appleReady: false, whisperReady: true }).state).toBe('ready');
});
