import { describe, it, expect, vi } from 'vitest';
import { InvalidAudioError, probeAudio } from './ffprobe.js';

describe('probeAudio', () => {
  it('classifies a decoder rejection, not an infrastructure failure, as invalid media', async () => {
    const rejected = { code: 1, stderr: 'moov atom not found' };
    await expect(probeAudio('/x.m4a', { runner: async () => { throw rejected; } })).rejects.toBeInstanceOf(InvalidAudioError);
    for (const error of [{ code: 'ENOENT' }, { code: 'EACCES' }, { code: 1, killed: true, stderr: 'moov atom not found' }, { code: 1, stderr: 'Resource temporarily unavailable' }]) {
      await expect(probeAudio('/x.m4a', { runner: async () => { throw error; } })).rejects.toBe(error);
    }
  });
  it.each(['NaN', 'Infinity', '0', '-1'])('rejects unusable duration %s', async (duration) => {
    await expect(probeAudio('/x.m4a', { runner: async () => ({ stdout: JSON.stringify({ format: { duration } }), stderr: '' }) })).rejects.toBeInstanceOf(InvalidAudioError);
  });
  it('parses duration from ffprobe JSON output', async () => {
    const runner = vi.fn(async () => ({
      stdout: JSON.stringify({ format: { duration: '12.5' } }), stderr: '',
    }));
    const info = await probeAudio('/x.mp3', { runner });
    expect(info.durationS).toBe(12.5);
  });

  it('throws on empty or invalid file', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: 'Invalid data' }));
    await expect(probeAudio('/x.mp3', { runner })).rejects.toThrow(/invalid|empty/i);
  });
});
