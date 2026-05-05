import { describe, it, expect } from 'vitest';
import {
  parseTranscript, fmtTimestamp, groupConsecutiveBySpeaker,
  formatTranscriptForExport,
} from './transcript-lines.js';

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

describe('groupConsecutiveBySpeaker', () => {
  it('collapses consecutive same-speaker lines into one block', () => {
    const lines = parseTranscript([
      '[Alice 00:00] Hi.',
      '[Alice 00:05] What I wanted to say.',
      '[Alice 00:12] Was about Q2.',
      '[Bob 00:20] Got it.',
    ].join('\n')).lines;
    const groups = groupConsecutiveBySpeaker(lines);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      speaker: 'Alice',
      startSeconds: 0,
      endSeconds: 12,
      text: 'Hi. What I wanted to say. Was about Q2.',
      lineIndices: [0, 1, 2],
    });
    expect(groups[1]).toMatchObject({
      speaker: 'Bob',
      startSeconds: 20,
      endSeconds: 20,
      text: 'Got it.',
      lineIndices: [3],
    });
  });

  it('starts a new block when the speaker changes (preserves conversation flow)', () => {
    const lines = parseTranscript([
      '[Alice 00:00] One.',
      '[Bob 00:05] Two.',
      '[Alice 00:10] Three.',
    ].join('\n')).lines;
    const groups = groupConsecutiveBySpeaker(lines);
    expect(groups.map((g) => g.speaker)).toEqual(['Alice', 'Bob', 'Alice']);
  });

  it('starts a new block when the gap exceeds gapSeconds', () => {
    const lines = parseTranscript([
      '[Alice 00:00] Earlier point.',
      '[Alice 02:00] Much later point.',
    ].join('\n')).lines;
    // Default gap is 90s; 120s exceeds it.
    const groups = groupConsecutiveBySpeaker(lines);
    expect(groups).toHaveLength(2);
    // With a generous override, the same lines collapse.
    const merged = groupConsecutiveBySpeaker(lines, { gapSeconds: 600 });
    expect(merged).toHaveLength(1);
  });

  it('returns an empty array for an empty input', () => {
    expect(groupConsecutiveBySpeaker([])).toEqual([]);
  });

  it('skips empty text fragments cleanly when joining', () => {
    const lines = parseTranscript([
      '[Alice 00:00] Hello.',
      '[Alice 00:02] ', // intentionally empty body
      '[Alice 00:05] Goodbye.',
    ].join('\n')).lines;
    const groups = groupConsecutiveBySpeaker(lines);
    expect(groups).toHaveLength(1);
    // No double-space, no trailing space.
    expect(groups[0]!.text).toBe('Hello. Goodbye.');
  });
});

describe('formatTranscriptForExport', () => {
  const sample = parseTranscript([
    '[Alice 00:00] Hi.',
    '[Alice 00:05] More from Alice.',
    '[Bob 00:10] Got it.',
  ].join('\n')).lines;

  it('per-line markdown bolds the speaker and uses inline timestamps', () => {
    const out = formatTranscriptForExport(sample, { viewMode: 'lines', format: 'md' });
    expect(out).toContain('**Alice** (00:00): Hi.');
    expect(out).toContain('**Bob** (00:10): Got it.');
  });

  it('per-line plain text omits markdown styling', () => {
    const out = formatTranscriptForExport(sample, { viewMode: 'lines', format: 'txt' });
    expect(out).toContain('Alice [00:00]: Hi.');
    expect(out).not.toContain('**');
  });

  it('grouped markdown collapses consecutive same-speaker lines into a quoted block', () => {
    const out = formatTranscriptForExport(sample, { viewMode: 'grouped', format: 'md' });
    // Alice gets one header with a range, then her merged text in a blockquote.
    expect(out).toContain('**Alice** (00:00 – 00:05)');
    expect(out).toContain('> Hi. More from Alice.');
    // Bob is a single-timestamp group — no range dash.
    expect(out).toContain('**Bob** (00:10)');
    expect(out).not.toContain('**Bob** (00:10 –');
  });

  it('grouped plain text uses Speaker (range): paragraphs', () => {
    const out = formatTranscriptForExport(sample, { viewMode: 'grouped', format: 'txt' });
    expect(out).toContain('Alice (00:00 – 00:05):');
    expect(out).toContain('Hi. More from Alice.');
    expect(out).not.toContain('**');
    expect(out).not.toContain('> ');
  });

  it('includes a header when a title is provided', () => {
    const out = formatTranscriptForExport(sample, {
      viewMode: 'lines', format: 'md', title: 'Q2 Review',
    });
    expect(out.startsWith('# Q2 Review')).toBe(true);
  });

  it('ends with exactly one trailing newline', () => {
    const out = formatTranscriptForExport(sample, { viewMode: 'grouped', format: 'md' });
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
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
