import { describe, it, expect } from 'vitest';
import { attentionSummary, readAttentionCollapsed, saveAttentionCollapsed } from './attention-summary';

const memory = (): Pick<Storage, 'getItem' | 'setItem'> => {
  const map = new Map<string, string>();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); } };
};

describe('attentionSummary', () => {
  it('joins counts with lower-case labels', () => {
    expect(attentionSummary([
      { label: 'Processing failed', totalCount: 1 },
      { label: 'Ready to process', totalCount: 2 },
    ])).toBe('1 processing failed · 2 ready to process');
  });
  it('is empty for no groups', () => { expect(attentionSummary([])).toBe(''); });
});

describe('collapsed preference', () => {
  it('defaults to expanded and round-trips', () => {
    const store = memory();
    expect(readAttentionCollapsed(store)).toBe(false);
    saveAttentionCollapsed(true, store);
    expect(readAttentionCollapsed(store)).toBe(true);
  });
  it('survives a throwing store', () => {
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(readAttentionCollapsed(broken)).toBe(false);
    expect(() => saveAttentionCollapsed(true, broken)).not.toThrow();
  });
});
