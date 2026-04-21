import { describe, it, expect } from 'vitest';
import { resolveHelperPath } from './helper-path.js';

describe('resolveHelperPath', () => {
  it('uses dev path when not packaged', () => {
    const p = resolveHelperPath({ isPackaged: false, appPath: '/proj' });
    expect(p).toBe('/proj/audio-tap/build/meeting-notes-tap');
  });

  it('uses bundled path when packaged', () => {
    const p = resolveHelperPath({ isPackaged: true, resourcesPath: '/MyApp.app/Contents/Resources' });
    expect(p).toBe('/MyApp.app/Contents/Resources/bin/meeting-notes-tap');
  });

  it('throws when packaged without resourcesPath', () => {
    expect(() => resolveHelperPath({ isPackaged: true })).toThrow();
  });

  it('throws when dev without appPath', () => {
    expect(() => resolveHelperPath({ isPackaged: false })).toThrow();
  });
});
