import { describe, it, expect } from 'vitest';
import { sanitizeSortKey } from './library-sort';

describe('sanitizeSortKey', () => {
  it('passes valid keys through', () => {
    expect(sanitizeSortKey('newest')).toBe('newest');
    expect(sanitizeSortKey('oldest')).toBe('oldest');
    expect(sanitizeSortKey('longest')).toBe('longest');
    expect(sanitizeSortKey('title')).toBe('title');
  });

  it('falls back to newest for junk (corrupt/missing localStorage)', () => {
    expect(sanitizeSortKey(null)).toBe('newest');
    expect(sanitizeSortKey(undefined)).toBe('newest');
    expect(sanitizeSortKey('shortest')).toBe('newest');
    expect(sanitizeSortKey(42)).toBe('newest');
  });
});
