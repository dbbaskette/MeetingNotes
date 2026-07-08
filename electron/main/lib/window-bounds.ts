// Pure helpers for persisting/restoring the main window's bounds across
// launches. The wiring (BrowserWindow events, settings repo, screen module)
// lives in electron/main/index.ts; everything testable is here.

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Structural subset of Electron's Display — lets tests pass plain objects
 *  while `screen.getAllDisplays()` satisfies it directly. */
export interface DisplayLike {
  bounds: { x: number; y: number; width: number; height: number };
}

/** Never restore below this — matches a size where the app is still usable
 *  even if it's smaller than the BrowserWindow's own minWidth/minHeight
 *  (which Electron enforces on top of whatever we pass). */
export const MIN_RESTORE_WIDTH = 700;
export const MIN_RESTORE_HEIGHT = 500;

/** How much of the window's title-bar strip must land on a display for the
 *  saved position to count as "visible": at least a 100px-wide slice of the
 *  top TITLE_BAR_H pixels. Anything less and the user can't grab the window
 *  to drag it back (detached-monitor protection). */
const TITLE_BAR_H = 40;
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_TITLE_H = 20;

/** Validate + normalize a persisted bounds value (which came out of a JSON
 *  settings row, so it can be absolutely anything). Returns null for garbage;
 *  otherwise rounds to integers and clamps the size up to the restore minimum. */
export function sanitizeBounds(value: unknown): WindowBounds | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const nums = [v.x, v.y, v.width, v.height];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return {
    x: Math.round(v.x as number),
    y: Math.round(v.y as number),
    width: Math.max(MIN_RESTORE_WIDTH, Math.round(v.width as number)),
    height: Math.max(MIN_RESTORE_HEIGHT, Math.round(v.height as number)),
  };
}

/** True when the window's title-bar region has a meaningful overlap with at
 *  least one of the given displays — i.e. the user can see and grab it. */
export function boundsVisibleOn(displays: DisplayLike[], bounds: WindowBounds): boolean {
  // The draggable strip is the top TITLE_BAR_H px of the window.
  const strip = { x: bounds.x, y: bounds.y, width: bounds.width, height: TITLE_BAR_H };
  for (const d of displays) {
    const b = d.bounds;
    const overlapW = Math.min(strip.x + strip.width, b.x + b.width) - Math.max(strip.x, b.x);
    const overlapH = Math.min(strip.y + strip.height, b.y + b.height) - Math.max(strip.y, b.y);
    if (overlapW >= MIN_VISIBLE_WIDTH && overlapH >= MIN_VISIBLE_TITLE_H) return true;
  }
  return false;
}
