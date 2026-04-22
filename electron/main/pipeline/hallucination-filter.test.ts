import { describe, it, expect } from 'vitest';
import { filterHallucinations, isWhisperNoise } from './hallucination-filter.js';

describe('isWhisperNoise', () => {
  it('matches known boilerplate phrases case-insensitively', () => {
    expect(isWhisperNoise('Thanks for watching.')).toBe(true);
    expect(isWhisperNoise('  Thanks for watching.  ')).toBe(true);
    expect(isWhisperNoise('THANKS FOR WATCHING!')).toBe(true);
    expect(isWhisperNoise('[BLANK_AUDIO]')).toBe(true);
    expect(isWhisperNoise('[Music]')).toBe(true);
    expect(isWhisperNoise(' you ')).toBe(true);
  });
  it('does not match real speech', () => {
    expect(isWhisperNoise('We should ship the migration.')).toBe(false);
    expect(isWhisperNoise('Thank you, Alice.')).toBe(false);
    expect(isWhisperNoise('Yes.')).toBe(false);
  });
});

describe('filterHallucinations', () => {
  it('drops unconditional noise phrases even when isolated', () => {
    const out = filterHallucinations([
      { start: 0, end: 5, text: 'Planning the next sprint.' },
      { start: 10, end: 15, text: '[BLANK_AUDIO]' },
      { start: 20, end: 25, text: 'Alice owns the migration.' },
    ]);
    expect(out.map((s) => s.text)).toEqual([
      'Planning the next sprint.',
      'Alice owns the migration.',
    ]);
  });

  it('keeps a single isolated "Thank you" as probably real', () => {
    const out = filterHallucinations([
      { start: 0, end: 3, text: 'Great meeting today.' },
      { start: 4, end: 5, text: 'Thank you.' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('drops a cluster of "Thank you" segments — the signature of silent-chunk hallucinations', () => {
    const out = filterHallucinations([
      { start: 0, end: 5, text: 'Real content here.' },
      { start: 30, end: 60, text: 'Thank you.' },
      { start: 60, end: 90, text: 'Thank you.' },
      { start: 90, end: 120, text: 'Thank you.' },
      { start: 150, end: 155, text: 'More real content.' },
    ]);
    expect(out.map((s) => s.text)).toEqual([
      'Real content here.',
      'More real content.',
    ]);
  });

  it('tolerates text variants of the thank-you cluster pattern', () => {
    const out = filterHallucinations([
      { start: 0, end: 30, text: 'Thank you' },
      { start: 30, end: 60, text: 'Thank you.' },
      { start: 60, end: 90, text: 'Thank you!' },
      { start: 120, end: 130, text: 'Actual content.' },
    ]);
    expect(out.map((s) => s.text)).toEqual(['Actual content.']);
  });
});
