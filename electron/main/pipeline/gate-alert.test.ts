import { describe, it, expect } from 'vitest';
import { shouldNotifyGate, clearGateNotified } from './gate-alert.js';

describe('shouldNotifyGate', () => {
  it('notifies the first time a meeting enters the gate, then suppresses repeats', () => {
    const notified = new Set<string>();
    // First entry into awaiting_speaker_id for this meeting — notify.
    expect(shouldNotifyGate('m1', notified)).toBe(true);
    // A duplicate transition for the SAME visit must not notify again.
    expect(shouldNotifyGate('m1', notified)).toBe(false);
  });

  it('notifies again after the meeting leaves the gate (genuine re-entry)', () => {
    const notified = new Set<string>();
    expect(shouldNotifyGate('m1', notified)).toBe(true);
    // User continued / un-skipped / re-ran — the flag is cleared on unblock.
    clearGateNotified('m1', notified);
    // A real re-entry into the gate deserves a fresh notification.
    expect(shouldNotifyGate('m1', notified)).toBe(true);
  });

  it('tracks meetings independently', () => {
    const notified = new Set<string>();
    expect(shouldNotifyGate('m1', notified)).toBe(true);
    expect(shouldNotifyGate('m2', notified)).toBe(true);
    expect(shouldNotifyGate('m1', notified)).toBe(false);
    expect(shouldNotifyGate('m2', notified)).toBe(false);
  });

  it('clearing an id that was never notified is a harmless no-op', () => {
    const notified = new Set<string>();
    expect(() => clearGateNotified('ghost', notified)).not.toThrow();
    expect(shouldNotifyGate('ghost', notified)).toBe(true);
  });
});
