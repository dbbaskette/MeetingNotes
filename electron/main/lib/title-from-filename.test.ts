import { describe, it, expect } from 'vitest';
import { parseRecordingFilename, parseAudioHijackFilename } from './title-from-filename.js';

describe('parseRecordingFilename — Audio Hijack format', () => {
  it('extracts ISO date and title from AH default format', () => {
    const r = parseRecordingFilename('Session 2026-04-17 14.32.mp3');
    expect(r.startedAtIso).toBe('2026-04-17T14:32:00');
    expect(r.autoTitle).toBe('Session');
  });
  it('handles session names with spaces', () => {
    const r = parseRecordingFilename('Q2 Planning 2026-04-17 09.05.mp3');
    expect(r.startedAtIso).toBe('2026-04-17T09:05:00');
    expect(r.autoTitle).toBe('Q2 Planning');
  });
  it('accepts full absolute paths', () => {
    const r = parseRecordingFilename('/Users/x/Music/Audio Hijack/Session 2026-04-17 14.32.mp3');
    expect(r.autoTitle).toBe('Session');
  });
});

describe('parseRecordingFilename — built-in recorder format', () => {
  it('extracts ISO date from recording-YYYYMMDD-HHMMSS-<id>.m4a', () => {
    const r = parseRecordingFilename('recording-20260429-200210-bfcb369a.m4a');
    expect(r.startedAtIso).toBe('2026-04-29T20:02:10');
    expect(r.autoTitle).toBe('recording-20260429-200210-bfcb369a');
  });
  it('handles the format without a trailing -<id> suffix', () => {
    const r = parseRecordingFilename('recording-20260429-200210.m4a');
    expect(r.startedAtIso).toBe('2026-04-29T20:02:10');
  });
  it('handles full absolute paths from the built-in recorder', () => {
    const r = parseRecordingFilename('/Users/x/Music/MeetingNotes/recording-20260417-031700-0485764c.m4a');
    expect(r.startedAtIso).toBe('2026-04-17T03:17:00');
  });
  it('does not match a similarly-named non-recorder file', () => {
    // Wrong digit counts → falls through to "unknown".
    const r = parseRecordingFilename('recording-2026-04-29.m4a');
    expect(r.startedAtIso).toBeNull();
  });
});

describe('parseRecordingFilename — fallback', () => {
  it('returns null timestamp + basename title when unrecognized', () => {
    const r = parseRecordingFilename('random-recording.mp3');
    expect(r.autoTitle).toBe('random-recording');
    expect(r.startedAtIso).toBeNull();
  });
});

describe('parseAudioHijackFilename (legacy alias)', () => {
  it('still works, dispatches through the same parser', () => {
    const r = parseAudioHijackFilename('Session 2026-04-17 14.32.mp3');
    expect(r.startedAtIso).toBe('2026-04-17T14:32:00');
  });
});
