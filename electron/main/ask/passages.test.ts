import { describe, expect, it } from 'vitest';
import { chunkSummary, chunkTranscript, ftsQuery, questionTerms } from './passages.js';

describe('chunkTranscript', () => {
  it('groups speaker turns into passages that start at the first line', () => {
    const md = ['[Alice 00:05] We should keep pricing at twenty.', '[Alice 00:09] For this year at least.',
      '[Bob 01:02:03] Agreed.', 'not a transcript line', '[Bob 01:02:10]   '].join('\n');
    expect(chunkTranscript(md)).toEqual([{ kind: 'transcript', startS: 5, heading: null,
      text: 'Alice: We should keep pricing at twenty. For this year at least.\nBob: Agreed.' }]);
  });
  it('starts a new passage when the size limit is reached and keeps its own start time', () => {
    const md = ['[A 00:01] ' + 'x'.repeat(30), '[B 00:40] ' + 'y'.repeat(30), '[A 01:10] done'].join('\n');
    const passages = chunkTranscript(md, 40);
    expect(passages.map((p) => p.startS)).toEqual([1, 40]);
    expect(passages[1]!.text).toBe(`B: ${'y'.repeat(30)}\nA: done`);
  });
});

describe('chunkSummary', () => {
  it('keeps each section under its heading and splits long sections on paragraphs', () => {
    const md = 'Intro line.\n\n## Decisions\n\nKeep pricing.\n\nShip in May.\n\n## Risks\n\n' + 'r'.repeat(50) + '\n\n' + 's'.repeat(50);
    expect(chunkSummary(md, 60)).toEqual([
      { kind: 'summary', startS: null, heading: null, text: 'Intro line.' },
      { kind: 'summary', startS: null, heading: 'Decisions', text: 'Keep pricing.\nShip in May.' },
      { kind: 'summary', startS: null, heading: 'Risks', text: 'r'.repeat(50) },
      { kind: 'summary', startS: null, heading: 'Risks', text: 's'.repeat(50) },
    ]);
  });
});

describe('question to query', () => {
  it('keeps content words once, in order', () => {
    expect(questionTerms("What did we decide about Priya's pricing — and the pricing rollout?")).toEqual(['decide', 'priya', 'pricing', 'rollout']);
    expect(questionTerms('what did they say')).toEqual([]);
  });
  it('quotes every term so input is never read as query syntax', () => {
    expect(ftsQuery(['pricing', 'NEAR(', 'a"b'])).toBe('"pricing" OR "NEAR(" OR "ab"');
    expect(ftsQuery([])).toBeNull();
  });
});
