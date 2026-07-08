import { describe, it, expect } from 'vitest';
import { createSilenceDetector } from './silence-detector';

const OPTS = { thresholdDb: -50, windowMs: 20_000, graceMs: 5_000 };
const t0 = 1_000_000; // arbitrary epoch anchor

function detectorFedSilenceFrom(start: number) {
  const d = createSilenceDetector(OPTS);
  d.feed(start, -70);
  return d;
}

describe('createSilenceDetector', () => {
  it('reports nothing before any feed', () => {
    const d = createSilenceDetector(OPTS);
    expect(d.isSilent(t0 + 60_000)).toBe(false);
  });

  it('stays quiet during the grace period even with a dead signal', () => {
    const d = detectorFedSilenceFrom(t0);
    d.feed(t0 + 2_000, -70);
    expect(d.isSilent(t0 + 4_999)).toBe(false);
  });

  it('trips after sustained silence from session start (20s window)', () => {
    const d = detectorFedSilenceFrom(t0);
    // Feed quiet peaks the whole way — 10Hz simulated at 1s granularity.
    for (let t = t0; t <= t0 + 19_000; t += 1_000) d.feed(t, -65);
    expect(d.isSilent(t0 + 19_999)).toBe(false); // 1ms short of the window
    expect(d.isSilent(t0 + 20_000)).toBe(true);
  });

  it('a single loud peak resets the silence window', () => {
    const d = detectorFedSilenceFrom(t0);
    d.feed(t0 + 15_000, -20); // someone spoke
    expect(d.isSilent(t0 + 20_000)).toBe(false);
    expect(d.isSilent(t0 + 34_999)).toBe(false); // 19.999s after the peak
    expect(d.isSilent(t0 + 35_000)).toBe(true); // 20s after the peak
  });

  it('a peak exactly at the threshold still counts as silence', () => {
    const d = detectorFedSilenceFrom(t0);
    d.feed(t0 + 10_000, -50); // == thresholdDb, not above it
    expect(d.isSilent(t0 + 20_000)).toBe(true);
  });

  it('recovery clears the warning and it re-arms afterwards', () => {
    const d = detectorFedSilenceFrom(t0);
    expect(d.isSilent(t0 + 25_000)).toBe(true); // tripped
    d.feed(t0 + 26_000, -10); // audio came back
    expect(d.isSilent(t0 + 26_500)).toBe(false); // cleared immediately
    // …and trips again after another full window of silence.
    expect(d.isSilent(t0 + 45_999)).toBe(false);
    expect(d.isSilent(t0 + 46_000)).toBe(true);
  });

  it('loud audio from the start never trips', () => {
    const d = createSilenceDetector(OPTS);
    for (let t = t0; t <= t0 + 60_000; t += 1_000) d.feed(t, -30);
    expect(d.isSilent(t0 + 60_000)).toBe(false);
  });
});
