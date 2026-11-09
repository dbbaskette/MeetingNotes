export const TOAST_CAP = 4;

/** Auto-dismiss delay, or null for a toast that stays until dismissed.
 *  Errors stay unless the caller sets a duration. */
export function toastDuration(request: { durationMs?: number | null; variant?: 'default' | 'error' }): number | null {
  if (request.durationMs !== undefined) return request.durationMs !== null && request.durationMs > 0 ? request.durationMs : null;
  return request.variant === 'error' ? null : 6000;
}

export function visibleToasts<T>(toasts: T[], cap: number = TOAST_CAP): T[] {
  return toasts.length > cap ? toasts.slice(-cap) : toasts;
}

export interface PausableTimer { pause(): void; resume(): void; cancel(): void; }

export function createPausableTimer(durationMs: number, onExpire: () => void): PausableTimer {
  let remaining = durationMs;
  let startedAt = Date.now();
  let handle: ReturnType<typeof setTimeout> | null = setTimeout(onExpire, remaining);
  let cancelled = false;
  return {
    pause() {
      if (cancelled || handle === null) return;
      clearTimeout(handle); handle = null;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
    },
    resume() {
      if (cancelled || handle !== null) return;
      startedAt = Date.now();
      handle = setTimeout(onExpire, remaining);
    },
    cancel() {
      cancelled = true;
      if (handle !== null) { clearTimeout(handle); handle = null; }
    },
  };
}
