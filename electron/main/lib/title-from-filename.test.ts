import { describe, it, expect } from 'vitest';
import { parseAudioHijackFilename } from './title-from-filename';

describe('parseAudioHijackFilename', () => {
  it('extracts ISO date and title from AH default format', () => {
    const r = parseAudioHijackFilename('Session 2026-04-17 14.32.mp3');
    expect(r.startedAtIso).toBe('2026-04-17T14:32:00');
    expect(r.autoTitle).toBe('Session');
  });
  it('handles session names with spaces', () => {
    const r = parseAudioHijackFilename('Q2 Planning 2026-04-17 09.05.mp3');
    expect(r.startedAtIso).toBe('2026-04-17T09:05:00');
    expect(r.autoTitle).toBe('Q2 Planning');
  });
  it('falls back when format is unexpected', () => {
    const r = parseAudioHijackFilename('random-recording.mp3');
    expect(r.autoTitle).toBe('random-recording');
    expect(r.startedAtIso).toBeNull();
  });
  it('accepts full absolute paths', () => {
    const r = parseAudioHijackFilename('/Users/x/Music/Audio Hijack/Session 2026-04-17 14.32.mp3');
    expect(r.autoTitle).toBe('Session');
  });
});
