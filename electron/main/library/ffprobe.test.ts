import { describe, it, expect, vi } from 'vitest';
import { probeAudio } from './ffprobe.js';

describe('probeAudio', () => {
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
