import { describe, expect, it } from 'vitest';
import { splitHighlight } from './find-highlight';

describe('splitHighlight', () => {
  it('marks every case-insensitive occurrence and keeps the original casing', () => {
    expect(splitHighlight('Plan the plan, PLANNING next', 'plan')).toEqual([
      { text: 'Plan', match: true }, { text: ' the ', match: false }, { text: 'plan', match: true },
      { text: ', ', match: false }, { text: 'PLAN', match: true }, { text: 'NING next', match: false },
    ]);
  });
  it('returns the text unmarked when there is no needle or no match', () => {
    expect(splitHighlight('Nothing here', '')).toEqual([{ text: 'Nothing here', match: false }]);
    expect(splitHighlight('Nothing here', '   ')).toEqual([{ text: 'Nothing here', match: false }]);
    expect(splitHighlight('Nothing here', 'zebra')).toEqual([{ text: 'Nothing here', match: false }]);
  });
  it('handles matches at both ends and adjacent matches', () => {
    expect(splitHighlight('aaXaa', 'aa')).toEqual([{ text: 'aa', match: true }, { text: 'X', match: false }, { text: 'aa', match: true }]);
    expect(splitHighlight('aaaa', 'aa')).toEqual([{ text: 'aa', match: true }, { text: 'aa', match: true }]);
  });
  it('treats the needle literally, not as a pattern', () => {
    expect(splitHighlight('cost is $5.00 (est.)', '$5.00 (')).toEqual([
      { text: 'cost is ', match: false }, { text: '$5.00 (', match: true }, { text: 'est.)', match: false },
    ]);
  });
  it('returns nothing for empty text', () => {
    expect(splitHighlight('', 'a')).toEqual([]);
  });
});
