import { describe, it, expect } from 'vitest';
import {
  filterHallucinations,
  isWhisperNoise,
  collapseRepeatedSentences,
  collapseRepetitionLoops,
} from './hallucination-filter.js';

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

const RAG = 'Retrieval augmented generation is another part of the organization.';

describe('collapseRepeatedSentences', () => {
  it('collapses a long run of one repeated sentence to a single instance', () => {
    const text = Array(60).fill(RAG).join(' ');
    expect(collapseRepeatedSentences(text)).toBe(RAG);
  });

  it('leaves short repeats (below threshold) untouched', () => {
    expect(collapseRepeatedSentences('Yes. Yes.')).toBe('Yes. Yes.');
    expect(collapseRepeatedSentences('No. No. No.')).toBe('No. No. No.');
  });

  it('collapses only the looped run, preserving surrounding real sentences', () => {
    const text = `Real opening sentence. ${Array(20).fill(RAG).join(' ')} Real closing sentence.`;
    expect(collapseRepeatedSentences(text)).toBe(`Real opening sentence. ${RAG} Real closing sentence.`);
  });

  it('matches repeats case- and whitespace-insensitively', () => {
    expect(collapseRepeatedSentences('Hi there. hi there.   HI THERE. hi there.')).toBe('Hi there.');
  });

  it('does not collapse alternating distinct sentences', () => {
    expect(collapseRepeatedSentences('A. B. A. B. A. B.')).toBe('A. B. A. B. A. B.');
  });
});

describe('collapseRepetitionLoops', () => {
  it('collapses a run of identical segments to a single segment', () => {
    const segs = Array.from({ length: 40 }, (_, i) => ({ start: i, end: i + 1, text: RAG }));
    const out = collapseRepetitionLoops(segs);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe(RAG);
    expect(out[0]!.start).toBe(0); // keeps the first of the run
  });

  it('collapses intra-segment loops and preserves real segments around them', () => {
    const out = collapseRepetitionLoops([
      { start: 0, end: 10, text: 'Welcome everyone to the call.' },
      { start: 10, end: 400, text: Array(80).fill(RAG).join(' ') },
      { start: 400, end: 410, text: 'Any questions?' },
    ]);
    expect(out.map((s) => s.text)).toEqual([
      'Welcome everyone to the call.',
      RAG,
      'Any questions?',
    ]);
  });

  it('keeps a short run of identical segments (below threshold)', () => {
    const out = collapseRepetitionLoops([
      { start: 0, end: 1, text: 'Okay.' },
      { start: 1, end: 2, text: 'Okay.' },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('filterHallucinations', () => {
  it('collapses an arbitrary whisper repetition loop spanning many segments', () => {
    // The TanzuLive recording: the looped sentence emitted across ~70 raw
    // segments (each the sentence once), plus a couple where whisper crammed
    // it dozens of times into a single segment.
    const segs = [
      { start: 0, end: 5, text: 'Real intro about RAG.' },
      ...Array.from({ length: 70 }, (_, i) => ({ start: 10 + i, end: 11 + i, text: RAG })),
      { start: 90, end: 95, text: Array(50).fill(RAG).join(' ') },
      { start: 95, end: 100, text: RAG },
      { start: 200, end: 205, text: 'Back to real content.' },
    ];
    const out = filterHallucinations(segs);
    const looped = out.filter((s) => s.text.includes(RAG));
    expect(looped.length).toBeLessThanOrEqual(1); // collapsed from ~72 to ≤1
    expect(out[0]!.text).toBe('Real intro about RAG.');
    expect(out.at(-1)!.text).toBe('Back to real content.');
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
