import { describe, it, expect, vi } from 'vitest';
import { probeAudioPermissions, requestMicAccess } from './audio.js';

describe('probeAudioPermissions', () => {
  it('parses helper JSON into mic + audioCapture states', async () => {
    const runner = vi.fn(async () => ({
      stdout: JSON.stringify({ event: 'permissions', mic: 'granted', audio_capture: 'denied' }) + '\n',
      stderr: '',
    }));
    const result = await probeAudioPermissions({ helperPath: '/bin/x', runner });
    expect(result).toEqual({ mic: 'granted', audioCapture: 'denied' });
  });

  it('returns unknown if no permissions line is emitted', async () => {
    const runner = vi.fn(async () => ({ stdout: '\n', stderr: '' }));
    expect(await probeAudioPermissions({ helperPath: '/x', runner })).toEqual({ mic: 'unknown', audioCapture: 'unknown' });
  });

  it('returns unknown on helper failure rather than throwing', async () => {
    const runner = vi.fn(async () => { throw new Error('boom'); });
    expect(await probeAudioPermissions({ helperPath: '/x', runner })).toEqual({ mic: 'unknown', audioCapture: 'unknown' });
  });
});

describe('requestMicAccess', () => {
  it('returns true when systemPreferences grants access', async () => {
    const askForMediaAccess = vi.fn(async (_type: 'microphone') => true);
    const result = await requestMicAccess({ askForMediaAccess });
    expect(result).toBe(true);
    expect(askForMediaAccess).toHaveBeenCalledWith('microphone');
  });

  it('returns false when the user denies access', async () => {
    const askForMediaAccess = vi.fn(async (_type: 'microphone') => false);
    const result = await requestMicAccess({ askForMediaAccess });
    expect(result).toBe(false);
    expect(askForMediaAccess).toHaveBeenCalledWith('microphone');
  });
});
