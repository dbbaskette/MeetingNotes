import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, nativeTheme: {}, shell: {} }));
import { registerSettingsHandlers } from './settings-handlers.js';
import type { IpcServices } from './handlers.js';
it('guards language changes and rejects removed engine settings, validates selection, and keeps setup explicit', async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let active: string | null = 'meeting', busy = false, engine = 'apple';
  const set = vi.fn(), prepare = vi.fn(), cancelSetup = vi.fn(), status = vi.fn();
  const nativeSpeech = { prepare, cancelSetup, status, snapshot: () => ({ supported: true, busy }) };
  registerSettingsHandlers({ handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as any,
    { nativeSpeech, settings: { set, get: (key: string) => key === 'transcriptionEngine' ? engine : 'en' }, pipeline: { getStatus: () => ({ currentId: active, queueLength: 0 }) } } as unknown as IpcServices);
  const call = (name: string, ...args: unknown[]) => handlers.get(name)!(null, ...args);
  expect(prepare).not.toHaveBeenCalled();
  expect(() => call('settings:set', 'sttLanguage', 'fr')).toThrow('Wait for processing');
  expect(() => call('native-speech:prepare')).toThrow('Wait for processing');
  active = null; busy = true;
  expect(() => call('settings:set', 'sttLanguage', 'fr')).toThrow('Wait for processing');
  expect(() => call('settings:set', 'transcriptionEngine', 'whisperkit')).toThrow('before changing the transcription engine');
  busy = false;
  expect(() => call('settings:set', 'speechProvider', 'cloud')).toThrow();
  for (const key of ['speechProvider', 'sttModel', 'sttUrl']) expect(() => call('settings:set', key, 'legacy')).toThrow();
  for (const channel of ['stt:probe', 'onboarding:whisper-list', 'onboarding:whisper-install', 'onboarding:hf-token-save', 'onboarding:hf-token-status']) expect(handlers.has(channel)).toBe(false);
  call('settings:set', 'sttLanguage', 'fr'); expect(set).toHaveBeenCalledWith('sttLanguage', 'fr');
  call('native-speech:prepare'); expect(prepare).toHaveBeenCalledWith('en', 'apple');
  // The engine is one of two known values and is saved like any other setting.
  for (const value of ['whisper-server', 'cloud', '', null, 1]) expect(() => call('settings:set', 'transcriptionEngine', value)).toThrow();
  call('settings:set', 'transcriptionEngine', 'whisperkit'); expect(set).toHaveBeenCalledWith('transcriptionEngine', 'whisperkit');
  engine = 'whisperkit';
  call('native-speech:status'); expect(status).toHaveBeenLastCalledWith('en', 'whisperkit');
  call('native-speech:prepare'); expect(prepare).toHaveBeenLastCalledWith('en', 'whisperkit');
  call('native-speech:cancel'); expect(cancelSetup).toHaveBeenCalledOnce();
});
