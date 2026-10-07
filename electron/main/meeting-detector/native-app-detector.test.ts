import { describe, it, expect, vi } from 'vitest';
import {
  NativeAppDetector,
  NATIVE_APP_DISMISS_MS,
} from './native-app-detector.js';

interface FakeSource {
  pid: number;
  bundleId: string | null;
  name: string | null;
  isMeetingApp: boolean;
  isRunningOutput: boolean;
}

function makeDetector(opts: {
  initialSources: FakeSource[];
  silenceMs?: number;
  isSuppressed?: () => boolean;
}): { detector: NativeAppDetector; setSources: (s: FakeSource[]) => void; advance: (ms: number) => void; now: () => number } {
  let nowMs = 10_000_000;
  let sources = opts.initialSources;
  const detector = new NativeAppDetector({
    appEnumerator: { list: async () => sources } as never,
    silenceMs: opts.silenceMs ?? 5000,
    isSuppressed: opts.isSuppressed,
    now: () => nowMs,
  });
  return {
    detector,
    setSources: (s) => { sources = s; },
    advance: (ms) => { nowMs += ms; },
    now: () => nowMs,
  };
}

const zoomActive: FakeSource = {
  pid: 7777, bundleId: 'us.zoom.xos', name: 'zoom.us', isMeetingApp: true, isRunningOutput: true,
};
const zoomIdle: FakeSource = { ...zoomActive, isRunningOutput: false };
const teamsActive: FakeSource = {
  pid: 8888, bundleId: 'com.microsoft.teams2', name: 'Microsoft Teams', isMeetingApp: true, isRunningOutput: true,
};

describe('NativeAppDetector', () => {
  it('reads live debounce without relaunch and serializes pending enumeration', async () => {
    let now = 0, debounce = 5000, suppressed = false;
    let resolve!: (sources: FakeSource[]) => void;
    const list = vi.fn(() => new Promise<FakeSource[]>(r => { resolve = r; }));
    const detector = new NativeAppDetector({ appEnumerator: { list } as never, now: () => now,
      getSilenceMs: () => debounce, isSuppressed: () => suppressed });
    const event = vi.fn(); detector.onDetected(event);
    const first = detector.tick(); await detector.tick(); expect(list).toHaveBeenCalledOnce(); resolve([zoomActive]); await first;
    now = 2000; debounce = 1000;
    const second = detector.tick(); resolve([zoomActive]); await second; expect(event).toHaveBeenCalledOnce();
    now = 9000;
    const third = detector.tick(); suppressed = true; resolve([teamsActive]); await third;
    expect(event).toHaveBeenCalledOnce();
    suppressed = false;
    const cancelled = detector.tick(); detector.stop(); resolve([teamsActive]); await cancelled;
    expect(event).toHaveBeenCalledOnce();
  });
  it('does not fire on the first tick — silenceMs must elapse first', async () => {
    const listener = vi.fn();
    const t = makeDetector({ initialSources: [zoomActive], silenceMs: 5000 });
    t.detector.onDetected(listener);
    await t.detector.tick();
    expect(listener).not.toHaveBeenCalled();
  });

  it('fires once sustained audio passes silenceMs', async () => {
    const listener = vi.fn();
    const t = makeDetector({ initialSources: [zoomActive], silenceMs: 5000 });
    t.detector.onDetected(listener);
    await t.detector.tick();         // first sighting
    t.advance(6000);
    await t.detector.tick();         // now over silenceMs threshold
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      source: 'native-app', appName: 'zoom.us', bundleId: 'us.zoom.xos', pid: 7777,
    });
  });

  it('does not re-fire on subsequent ticks while audio is still running', async () => {
    const listener = vi.fn();
    const t = makeDetector({ initialSources: [zoomActive] });
    t.detector.onDetected(listener);
    await t.detector.tick();
    t.advance(6000);
    await t.detector.tick();
    t.advance(3000);
    await t.detector.tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('re-fires after the app stops audio and starts again (edge trigger)', async () => {
    const listener = vi.fn();
    const t = makeDetector({ initialSources: [zoomActive], silenceMs: 5000 });
    t.detector.onDetected(listener);
    await t.detector.tick();
    t.advance(6000);
    await t.detector.tick();
    expect(listener).toHaveBeenCalledTimes(1);
    // Zoom stops producing audio (call ends)
    t.setSources([zoomIdle]);
    await t.detector.tick();
    // Zoom starts a new call
    t.setSources([zoomActive]);
    await t.detector.tick();
    t.advance(6000);
    await t.detector.tick();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('debounces brief audio blips below silenceMs (no banner spam)', async () => {
    const listener = vi.fn();
    const t = makeDetector({ initialSources: [zoomActive], silenceMs: 5000 });
    t.detector.onDetected(listener);
    await t.detector.tick();          // first sighting
    t.advance(2000);
    t.setSources([zoomIdle]);
    await t.detector.tick();          // audio stopped before threshold
    t.advance(2000);
    t.setSources([zoomActive]);
    await t.detector.tick();          // back on — timer resets
    t.advance(4000);
    await t.detector.tick();          // still under threshold
    expect(listener).not.toHaveBeenCalled();
  });

  it('respects dismiss() for 15 minutes', async () => {
    const listener = vi.fn();
    const t = makeDetector({ initialSources: [zoomActive], silenceMs: 5000 });
    t.detector.onDetected(listener);
    t.detector.dismiss('us.zoom.xos');
    await t.detector.tick();
    t.advance(6000);
    await t.detector.tick();
    expect(listener).not.toHaveBeenCalled();
    // Stop + restart the audio session — dismissal should still hold
    t.setSources([zoomIdle]); await t.detector.tick();
    t.setSources([zoomActive]); await t.detector.tick();
    t.advance(6000);
    await t.detector.tick();
    expect(listener).not.toHaveBeenCalled();
    // After 15 minutes the dismissal lapses
    t.advance(NATIVE_APP_DISMISS_MS + 1);
    await t.detector.tick();
    t.advance(6000);
    await t.detector.tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('respects isSuppressed (e.g. recording already active)', async () => {
    const listener = vi.fn();
    const t = makeDetector({ initialSources: [zoomActive], isSuppressed: () => true });
    t.detector.onDetected(listener);
    await t.detector.tick();
    t.advance(10_000);
    await t.detector.tick();
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores non-meeting apps (no Spotify banner)', async () => {
    const listener = vi.fn();
    const spotify: FakeSource = {
      pid: 1234, bundleId: 'com.spotify.client', name: 'Spotify',
      isMeetingApp: false, isRunningOutput: true,
    };
    const t = makeDetector({ initialSources: [spotify] });
    t.detector.onDetected(listener);
    await t.detector.tick();
    t.advance(10_000);
    await t.detector.tick();
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores meeting apps that are idle (registered but not playing)', async () => {
    const listener = vi.fn();
    const t = makeDetector({ initialSources: [zoomIdle] });
    t.detector.onDetected(listener);
    await t.detector.tick();
    t.advance(10_000);
    await t.detector.tick();
    expect(listener).not.toHaveBeenCalled();
  });

  it('fires for whichever meeting app activates first', async () => {
    const listener = vi.fn();
    const t = makeDetector({ initialSources: [zoomActive, teamsActive], silenceMs: 5000 });
    t.detector.onDetected(listener);
    await t.detector.tick();
    t.advance(6000);
    await t.detector.tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('swallows enumerator errors', async () => {
    const detector = new NativeAppDetector({
      appEnumerator: { list: async () => { throw new Error('helper crashed'); } } as never,
    });
    const listener = vi.fn();
    detector.onDetected(listener);
    await expect(detector.tick()).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });
});
