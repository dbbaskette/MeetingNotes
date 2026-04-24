import { describe, it, expect } from 'vitest';
import { parseTranscript, fmtTimestamp } from './transcript-lines.js';

describe('parseTranscript', () => {
  it('parses MM:SS lines into seekable records', () => {
    const t = '[Alice 00:00] Hi there.\n[Bob 00:05] Hello!';
    const out = parseTranscript(t);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatchObject({ speaker: 'Alice', seconds: 0, text: 'Hi there.' });
    expect(out.lines[1]).toMatchObject({ speaker: 'Bob', seconds: 5, text: 'Hello!' });
    expect(out.hasUnparsed).toBe(false);
  });

  it('parses H:MM:SS lines for long meetings', () => {
    const t = '[Alice 1:02:03] Late in the meeting.';
    const out = parseTranscript(t);
    expect(out.lines[0]!.seconds).toBe(1 * 3600 + 2 * 60 + 3);
  });

  it('handles multi-word speaker names', () => {
    const t = '[Alice Smith 00:10] Hello.';
    const out = parseTranscript(t);
    expect(out.lines[0]!.speaker).toBe('Alice Smith');
    expect(out.lines[0]!.seconds).toBe(10);
  });

  it('preserves SPEAKER_00-style default labels', () => {
    const t = '[SPEAKER_00 00:00] Something.';
    const out = parseTranscript(t);
    expect(out.lines[0]!.speaker).toBe('SPEAKER_00');
  });

  it('flags hasUnparsed when any line lacks the timestamp prefix', () => {
    const t = '[Alice 00:00] Good.\nJust some prose with no prefix.';
    expect(parseTranscript(t).hasUnparsed).toBe(true);
  });

  it('skips blank lines without flagging them as unparsed', () => {
    const t = '[Alice 00:00] Hi.\n\n[Bob 00:05] Back.\n';
    const out = parseTranscript(t);
    expect(out.lines).toHaveLength(2);
    expect(out.hasUnparsed).toBe(false);
  });
});

describe('fmtTimestamp', () => {
  it('MM:SS under one hour', () => {
    expect(fmtTimestamp(0)).toBe('00:00');
    expect(fmtTimestamp(65)).toBe('01:05');
    expect(fmtTimestamp(3599)).toBe('59:59');
  });
  it('H:MM:SS at and over one hour', () => {
    expect(fmtTimestamp(3600)).toBe('1:00:00');
    expect(fmtTimestamp(3723)).toBe('1:02:03');
  });
});
