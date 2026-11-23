import { describe, expect, it } from 'vitest';
import { nextRowId } from './row-keyboard-nav';

describe('nextRowId', () => {
  const ids = ['a', 'b', 'c'];
  it('enters the list from either end when no row has focus', () => {
    expect(nextRowId(ids, null, 1)).toBe('a');
    expect(nextRowId(ids, null, -1)).toBe('c');
  });
  it('moves one row and stops at the ends', () => {
    expect(nextRowId(ids, 'a', 1)).toBe('b');
    expect(nextRowId(ids, 'c', 1)).toBe('c');
    expect(nextRowId(ids, 'a', -1)).toBe('a');
  });
  it('treats a row that is no longer rendered as no focus', () => {
    expect(nextRowId(ids, 'gone', 1)).toBe('a');
  });
  it('returns null for an empty list', () => {
    expect(nextRowId([], null, 1)).toBeNull();
  });
});
