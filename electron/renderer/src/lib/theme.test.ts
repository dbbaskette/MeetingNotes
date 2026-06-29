import { describe, it, expect } from 'vitest';
import { resolveDark, type ThemeChoice } from './theme';

describe('resolveDark', () => {
  it('forces dark regardless of system', () => {
    expect(resolveDark('dark', false)).toBe(true);
    expect(resolveDark('dark', true)).toBe(true);
  });
  it('forces light regardless of system', () => {
    expect(resolveDark('light', true)).toBe(false);
    expect(resolveDark('light', false)).toBe(false);
  });
  it('follows the system preference when set to system', () => {
    expect(resolveDark('system', true)).toBe(true);
    expect(resolveDark('system', false)).toBe(false);
  });
});
