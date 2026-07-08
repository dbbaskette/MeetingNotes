import { describe, it, expect, afterEach } from 'vitest';
import { setUnsavedGuard, confirmLeave } from './unsaved-guard';

afterEach(() => setUnsavedGuard(null));

describe('unsaved-guard', () => {
  it('allows navigation when no guard is registered', () => {
    expect(confirmLeave()).toBe(true);
  });

  it('consults the registered guard', () => {
    let asked = 0;
    setUnsavedGuard(() => { asked++; return false; });
    expect(confirmLeave()).toBe(false);
    setUnsavedGuard(() => { asked++; return true; });
    expect(confirmLeave()).toBe(true);
    expect(asked).toBe(2);
  });

  it('clearing the guard restores the default allow', () => {
    setUnsavedGuard(() => false);
    expect(confirmLeave()).toBe(false);
    setUnsavedGuard(null);
    expect(confirmLeave()).toBe(true);
  });
});
