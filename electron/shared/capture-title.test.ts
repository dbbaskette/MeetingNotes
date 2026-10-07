import { describe, it, expect } from 'vitest';
import { captureTitle } from './capture-title';
describe('optional capture titles', () => {
  it('keeps defaults optional and validates one-line bounded intent', () => {
    expect(captureTitle('   ')).toBeUndefined();
    expect(captureTitle('  Platform SLSA  ')).toBe('Platform SLSA');
    expect(() => captureTitle('x'.repeat(201))).toThrow();
    expect(() => captureTitle('a\nb')).toThrow();
  });
});
