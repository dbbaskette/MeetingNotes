// electron/renderer/src/lib/shared-interval.ts
//
// Ref-counted interval: several components can hold the same poll loop
// without stacking timers. Born from LibraryView and PipelineStatusBar each
// running their own 3s meetings:list poll — on the Library during processing
// that doubled every IPC + DB hit for identical data. One timer runs while at
// least one holder is live; the last release stops it.

export interface SharedInterval {
  /** Start holding the interval. Returns a release function; releasing the
   *  last hold stops the timer. Safe to call the release more than once. */
  acquire(): () => void;
}

export function createSharedInterval(fn: () => void, ms: number): SharedInterval {
  let holds = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    acquire() {
      holds++;
      if (!timer) timer = setInterval(fn, ms);
      let released = false;
      return () => {
        if (released) return; // double release must not underflow the count
        released = true;
        holds--;
        if (holds === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}
