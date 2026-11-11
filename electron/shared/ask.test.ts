import { describe, expect, it } from 'vitest';
import { answerParts } from './ask.js';

describe('answerParts', () => {
  it('separates text from citations that point at a real source', () => {
    expect(answerParts('Pricing stays [1]. Hiring paused [2][7].', 2)).toEqual([
      { text: 'Pricing stays ' }, { cite: 1 }, { text: '. Hiring paused ' }, { cite: 2 }, { text: '[7].' },
    ]);
    expect(answerParts('No citations here.', 3)).toEqual([{ text: 'No citations here.' }]);
  });
});
