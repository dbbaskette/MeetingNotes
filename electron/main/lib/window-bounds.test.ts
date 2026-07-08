import { describe, it, expect } from 'vitest';
import { boundsVisibleOn, sanitizeBounds } from './window-bounds.js';

const MAIN = { bounds: { x: 0, y: 0, width: 1440, height: 900 } };
const SECOND = { bounds: { x: 1440, y: -200, width: 2560, height: 1440 } };

describe('boundsVisibleOn', () => {
  it('accepts a window fully inside the primary display', () => {
    expect(boundsVisibleOn([MAIN], { x: 100, y: 100, width: 1200, height: 700 })).toBe(true);
  });

  it('rejects a window fully off-screen (stale monitor position)', () => {
    expect(boundsVisibleOn([MAIN], { x: 5000, y: 100, width: 1200, height: 800 })).toBe(false);
    expect(boundsVisibleOn([MAIN], { x: 100, y: -2000, width: 1200, height: 800 })).toBe(false);
  });

  it('rejects a sliver — too little of the title bar left to grab', () => {
    // Only 50px of the window pokes in from the right edge.
    expect(boundsVisibleOn([MAIN], { x: 1390, y: 100, width: 1200, height: 800 })).toBe(false);
    // Title bar is above the display top: only body visible, no grab handle.
    expect(boundsVisibleOn([MAIN], { x: 100, y: -100, width: 1200, height: 800 })).toBe(false);
  });

  it('accepts a partially visible window with a grabbable title-bar strip', () => {
    // 150px of the title bar remains on-screen from the left.
    expect(boundsVisibleOn([MAIN], { x: -1050, y: 100, width: 1200, height: 800 })).toBe(true);
  });

  it('accepts second-monitor coordinates (including negative y)', () => {
    expect(boundsVisibleOn([MAIN, SECOND], { x: 2000, y: -100, width: 1200, height: 800 })).toBe(true);
    // …but not once that monitor is detached.
    expect(boundsVisibleOn([MAIN], { x: 2000, y: -100, width: 1200, height: 800 })).toBe(false);
  });

  it('handles no displays at all', () => {
    expect(boundsVisibleOn([], { x: 0, y: 0, width: 1200, height: 800 })).toBe(false);
  });
});

describe('sanitizeBounds', () => {
  it('passes a valid bounds object through (rounded to integers)', () => {
    expect(sanitizeBounds({ x: 10.6, y: 20.2, width: 1200.4, height: 800.9 }))
      .toEqual({ x: 11, y: 20, width: 1200, height: 801 });
  });

  it('clamps the size up to the restore minimum (700×500)', () => {
    expect(sanitizeBounds({ x: 0, y: 0, width: 300, height: 200 }))
      .toEqual({ x: 0, y: 0, width: 700, height: 500 });
  });

  it('rejects garbage input', () => {
    expect(sanitizeBounds(null)).toBeNull();
    expect(sanitizeBounds(undefined)).toBeNull();
    expect(sanitizeBounds('1200x800')).toBeNull();
    expect(sanitizeBounds(42)).toBeNull();
    expect(sanitizeBounds({})).toBeNull();
    expect(sanitizeBounds({ x: 0, y: 0, width: 1200 })).toBeNull();
    expect(sanitizeBounds({ x: '0', y: 0, width: 1200, height: 800 })).toBeNull();
  });

  it('rejects non-finite numbers', () => {
    expect(sanitizeBounds({ x: NaN, y: 0, width: 1200, height: 800 })).toBeNull();
    expect(sanitizeBounds({ x: 0, y: Infinity, width: 1200, height: 800 })).toBeNull();
    expect(sanitizeBounds({ x: 0, y: 0, width: -Infinity, height: 800 })).toBeNull();
  });

  it('allows negative positions (second monitor above/left of primary)', () => {
    expect(sanitizeBounds({ x: -2560, y: -200, width: 1200, height: 800 }))
      .toEqual({ x: -2560, y: -200, width: 1200, height: 800 });
  });
});
