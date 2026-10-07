import { describe, it, expect } from 'vitest';
import { DiscoverFailureGate } from './discover-failure-gate.js';

const st = (size: number, mtimeMs: number) => ({ size, mtimeMs });

describe('DiscoverFailureGate', () => {
  it('retries stable valid files after transient failures cool down', () => {
    let now = 0;
    const gate = new DiscoverFailureGate(3, () => now);
    for (let attempt = 0; attempt < 6; attempt++) {
      gate.recordTransientFailure('/a.m4a', st(42, 1));
      expect(gate.shouldSkip('/a.m4a', st(42, 1))).toBe(true);
      now += 60_001;
      expect(gate.shouldSkip('/a.m4a', st(42, 1))).toBe(false);
    }
  });
  it('bounds remembered failures', () => {
    const gate = new DiscoverFailureGate(1, Date.now, 2);
    for (const p of ['/a', '/b', '/c']) gate.recordFailure(p, st(1, 1));
    expect(gate.shouldSkip('/a', st(1, 1))).toBe(false);
    expect(gate.shouldSkip('/c', st(1, 1))).toBe(true);
  });
  it('allows maxFails attempts for an unchanged file, then quarantines', () => {
    const g = new DiscoverFailureGate(3);
    expect(g.recordFailure('/a.m4a', st(557, 1))).toBe('retry');
    expect(g.recordFailure('/a.m4a', st(557, 1))).toBe('retry');
    expect(g.recordFailure('/a.m4a', st(557, 1))).toBe('quarantined');
    expect(g.shouldSkip('/a.m4a', st(557, 1))).toBe(true);
  });

  it('does not skip before the limit is reached', () => {
    const g = new DiscoverFailureGate(3);
    g.recordFailure('/a.m4a', st(557, 1));
    expect(g.shouldSkip('/a.m4a', st(557, 1))).toBe(false);
  });

  it('resets when the file changes on disk (late finalization)', () => {
    const g = new DiscoverFailureGate(3);
    for (let i = 0; i < 3; i++) g.recordFailure('/a.m4a', st(557, 1));
    expect(g.shouldSkip('/a.m4a', st(557, 1))).toBe(true);
    // Recorder finalizes the moov atom → size/mtime move → probe again.
    expect(g.shouldSkip('/a.m4a', st(81_000, 2))).toBe(false);
    expect(g.recordFailure('/a.m4a', st(81_000, 2))).toBe('retry');
  });

  it('tracks paths independently and clears on success', () => {
    const g = new DiscoverFailureGate(1);
    expect(g.recordFailure('/a.m4a', st(1, 1))).toBe('quarantined');
    expect(g.shouldSkip('/b.m4a', st(1, 1))).toBe(false);
    g.clear('/a.m4a');
    expect(g.shouldSkip('/a.m4a', st(1, 1))).toBe(false);
  });
});
