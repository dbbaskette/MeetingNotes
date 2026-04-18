import { describe, it, expect } from 'vitest';
import { ActionItemSchema, parseActionItemsLoose } from './action-item-schema.js';

describe('ActionItemSchema', () => {
  it('accepts a full item', () => {
    const v = ActionItemSchema.parse({ text: 'do X', owner: 'Dan', due_date: '2026-04-22' });
    expect(v.text).toBe('do X');
  });
  it('accepts nulls for owner / due_date', () => {
    const v = ActionItemSchema.parse({ text: 'follow up', owner: null, due_date: null });
    expect(v.owner).toBeNull();
  });
  it('rejects empty text', () => {
    expect(() => ActionItemSchema.parse({ text: '', owner: null, due_date: null })).toThrow();
  });
});

describe('parseActionItemsLoose', () => {
  it('extracts a JSON array from messy LLM output', () => {
    const raw = 'Sure:\n```json\n[{"text":"a","owner":null,"due_date":null}]\n```\nCheers!';
    expect(parseActionItemsLoose(raw)).toHaveLength(1);
  });
  it('returns [] when no JSON array is present', () => {
    expect(parseActionItemsLoose('no items today')).toEqual([]);
  });
  it('discards invalid items but keeps valid ones', () => {
    const raw = '[{"text":"ok","owner":null,"due_date":null},{"owner":"Dan"}]';
    expect(parseActionItemsLoose(raw)).toHaveLength(1);
  });
});
