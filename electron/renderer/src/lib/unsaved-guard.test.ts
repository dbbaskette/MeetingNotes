import { describe, it, expect, afterEach } from 'vitest';
import { setUnsavedGuard, requestLeave } from './unsaved-guard';

afterEach(() => setUnsavedGuard(null));

describe('unsaved-guard', () => {
  it('allows navigation when no guard is registered', async () => {
    expect(await requestLeave()).toBe(true);
  });

  it('consults the registered guard', async () => {
    let asked = 0;
    setUnsavedGuard(() => { asked++; return false; });
    expect(await requestLeave()).toBe(false);
    setUnsavedGuard(() => { asked++; return true; });
    expect(await requestLeave()).toBe(true);
    expect(asked).toBe(2);
  });

  it('awaits asynchronous guards', async () => {
    setUnsavedGuard(() => Promise.resolve(false));
    expect(await requestLeave()).toBe(false);
  });

  it('clearing the guard restores the default allow', async () => {
    setUnsavedGuard(() => false);
    expect(await requestLeave()).toBe(false);
    setUnsavedGuard(null);
    expect(await requestLeave()).toBe(true);
  });
});
