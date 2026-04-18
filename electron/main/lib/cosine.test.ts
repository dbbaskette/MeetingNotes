import { describe, it, expect } from 'vitest';
import { cosineSimilarity, normalize } from './cosine.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 6);
  });
  it('throws on mismatched length', () => {
    expect(() => cosineSimilarity([1, 2], [1])).toThrow(/length/i);
  });
  it('throws on zero vector', () => {
    expect(() => cosineSimilarity([0, 0], [1, 1])).toThrow(/zero/i);
  });
});

describe('normalize', () => {
  it('makes the vector unit length', () => {
    const u = normalize([3, 4]);
    expect(Math.hypot(...u)).toBeCloseTo(1, 6);
    expect(u[0]!).toBeCloseTo(0.6, 6);
    expect(u[1]!).toBeCloseTo(0.8, 6);
  });
});
