import { describe, it, expect } from 'vitest';
import { makeSlug, shortId } from './slug';

describe('makeSlug', () => {
  it('combines date, kebab title, and short id', () => {
    expect(makeSlug('2026-04-17', 'Q2 Planning', 'a3f8')).toBe('2026-04-17-q2-planning-a3f8');
  });
  it('strips punctuation and lowercases', () => {
    expect(makeSlug('2026-04-17', "Sarah's 1:1!", 'xyz1')).toBe('2026-04-17-sarahs-1-1-xyz1');
  });
  it('collapses multiple spaces/dashes', () => {
    expect(makeSlug('2026-04-17', '  Product — Sync  ', 'z9')).toBe('2026-04-17-product-sync-z9');
  });
  it('truncates very long titles', () => {
    const long = 'a'.repeat(100);
    const out = makeSlug('2026-04-17', long, 'id1');
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('-id1')).toBe(true);
  });
});

describe('shortId', () => {
  it('returns 4 lowercase alphanumeric chars', () => {
    const id = shortId();
    expect(id).toMatch(/^[a-z0-9]{4}$/);
  });
  it('is reasonably unique across calls', () => {
    const set = new Set(Array.from({ length: 500 }, () => shortId()));
    expect(set.size).toBeGreaterThan(490);
  });
});
