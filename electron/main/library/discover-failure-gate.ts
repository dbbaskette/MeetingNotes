// Stops the discover → ffprobe-fail → release → re-emit loop from spinning
// forever on files that will never become valid (header-only stubs from a
// killed recorder, foreign junk dropped into a watch folder). Failures are
// counted against the file's exact on-disk state (size + mtime): while the
// state is unchanged the file gets maxFails probe attempts and then goes
// quiet; any real change — e.g. a recorder finalizing its moov atom late —
// resets the slate and probing resumes.

import fs from 'node:fs';

export interface FileState {
  size: number;
  mtimeMs: number;
}

/** Snapshot a file's identity-relevant stat, or null when unreadable
 *  (deleted between the watcher event and the probe, permissions, …). */
export function fileState(p: string): FileState | null {
  try {
    const st = fs.statSync(p);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

export class DiscoverFailureGate {
  private readonly state = new Map<string, FileState & { fails: number }>();

  constructor(private readonly maxFails = 3) {}

  /** True when probing this path again is pointless: it already exhausted
   *  its attempts and the file hasn't changed since. Callers should skip
   *  silently — the failure was already logged when it quarantined. */
  shouldSkip(p: string, st: FileState): boolean {
    const rec = this.state.get(p);
    if (!rec) return false;
    if (rec.size !== st.size || rec.mtimeMs !== st.mtimeMs) return false;
    return rec.fails >= this.maxFails;
  }

  /** Record a probe failure for the given on-disk state. Returns 'retry'
   *  while attempts remain for this exact state, 'quarantined' on the
   *  attempt that exhausts them. A changed file resets the count. */
  recordFailure(p: string, st: FileState): 'retry' | 'quarantined' {
    const rec = this.state.get(p);
    if (!rec || rec.size !== st.size || rec.mtimeMs !== st.mtimeMs) {
      this.state.set(p, { ...st, fails: 1 });
      return this.maxFails <= 1 ? 'quarantined' : 'retry';
    }
    rec.fails += 1;
    return rec.fails >= this.maxFails ? 'quarantined' : 'retry';
  }

  /** Forget a path after a successful probe (or deletion). */
  clear(p: string): void {
    this.state.delete(p);
  }
}
