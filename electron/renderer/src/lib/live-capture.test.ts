import { describe, expect, it, vi } from 'vitest';
vi.mock('../ipc/client', () => ({ api: { recording: { onLevel: () => () => {} } } }));
import { createLiveCapture } from './live-capture';

function harness() {
  let emit: (event: { sessionId: string; source?: 'mic' | 'system' | 'mixed'; peakDb: number }) => void = () => {};
  let subscriptions = 0, clock = 1_000;
  const store = createLiveCapture((cb) => { subscriptions++; emit = cb; return () => { subscriptions--; emit = () => {}; }; }, () => clock);
  return { store, emit: (event: Parameters<typeof emit>[0]) => emit(event), subscriptions: () => subscriptions, tick: (ms: number) => { clock += ms; } };
}

describe('live capture store', () => {
  it('keeps what it has heard when one reader leaves and another arrives (a view switch)', () => {
    const h = harness();
    const app = h.store.attach('s1');
    const libraryRow = h.store.attach('s1');
    h.emit({ sessionId: 's1', source: 'mic', peakDb: -20 });
    h.emit({ sessionId: 's1', source: 'system', peakDb: -30 });
    libraryRow(); // leave the Library
    const pill = h.store.attach('s1'); // compact pill on another view
    expect(h.subscriptions()).toBe(1);
    expect(h.store.getSignals().lastAudibleAt.mic).toBe(1_000);
    expect(h.store.getSignals().received).toEqual({ mic: true, system: true });
    expect([...h.store.seen()].sort()).toEqual(['mic', 'system']);
    pill(); app();
    expect(h.subscriptions()).toBe(0);
  });

  it('survives every reader detaching and re-attaching to the same session', () => {
    const h = harness();
    h.store.attach('s1')();
    const again = h.store.attach('s1');
    h.emit({ sessionId: 's1', source: 'mixed', peakDb: -10 });
    again();
    h.store.attach('s1');
    expect(h.store.seen().has('mixed')).toBe(true);
  });

  it('starts clean for a different session and ignores other sessions\' levels', () => {
    const h = harness();
    h.store.attach('s1');
    h.emit({ sessionId: 's1', source: 'mic', peakDb: -20 });
    h.store.attach('s2');
    expect(h.store.getSignals()).toEqual({ received: {}, lastAudibleAt: {} });
    expect(h.store.seen().size).toBe(0);
    h.emit({ sessionId: 's1', source: 'mic', peakDb: -20 });
    expect(h.store.getSignals().received.mic).toBeUndefined();
  });

  it('records silent samples as received but not audible (starvation vs a quiet call)', () => {
    const h = harness();
    h.store.attach('s1');
    h.emit({ sessionId: 's1', source: 'system', peakDb: -160 });
    expect(h.store.getSignals().received.system).toBe(true);
    expect(h.store.getSignals().lastAudibleAt.system).toBeUndefined();
    expect(h.store.seen().has('system')).toBe(false);
  });

  it('notifies signal readers at most once a second per audible source, peak readers every change', () => {
    const h = harness();
    h.store.attach('s1');
    const signals = vi.fn(), peaks = vi.fn();
    h.store.subscribeSignals(signals); h.store.subscribePeaks(peaks);
    h.emit({ sessionId: 's1', source: 'mic', peakDb: -20 });
    h.tick(100); h.emit({ sessionId: 's1', source: 'mic', peakDb: -21 });
    h.tick(100); h.emit({ sessionId: 's1', source: 'mic', peakDb: -22 });
    expect(signals).toHaveBeenCalledTimes(1);
    expect(peaks).toHaveBeenCalledTimes(3);
    h.tick(1_000); h.emit({ sessionId: 's1', source: 'mic', peakDb: -23 });
    expect(signals).toHaveBeenCalledTimes(2);
  });
});
