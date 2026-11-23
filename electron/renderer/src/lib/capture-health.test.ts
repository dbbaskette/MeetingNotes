import { describe, expect, it } from 'vitest';
import { captureSummary, deriveCaptureHealth } from './capture-health.js';

const startedAtMs = 1_000;

describe('deriveCaptureHealth', () => {
  it('does not warn about a deliberately disabled microphone', () => {
    expect(deriveCaptureHealth({ startedAtMs, nowMs: 30000, micEnabled: false,
      lastAudibleAt: { system: 29000, mixed: 29000 } }).state).toBe('healthy');
  });
  it('reports a startup preflight during the grace period', () => {
    expect(deriveCaptureHealth({ startedAtMs, nowMs: 5_000, lastAudibleAt: {} }).state).toBe('checking');
  });

  it('reports app audio specifically when only the microphone is active', () => {
    const result = deriveCaptureHealth({
      startedAtMs,
      nowMs: 30_000,
      lastAudibleAt: { mic: 29_000, mixed: 29_000 },
    });
    expect(result.state).toBe('warning');
    expect(result.warning).toBe('app-silent');
    expect(result.message).toContain('app audio');
  });

  it('reports microphone audio specifically when only app audio is active', () => {
    const result = deriveCaptureHealth({
      startedAtMs,
      nowMs: 30_000,
      lastAudibleAt: { system: 29_000, mixed: 29_000 },
    });
    expect(result.warning).toBe('mic-silent');
  });

  it('distinguishes active inputs from a stalled recording output', () => {
    const result = deriveCaptureHealth({
      startedAtMs,
      nowMs: 30_000,
      lastAudibleAt: { mic: 29_000, system: 29_000 },
    });
    expect(result.warning).toBe('output-silent');
  });

  it('reports both inputs as missing when every stream is silent', () => {
    const result = deriveCaptureHealth({ startedAtMs, nowMs: 30_000, lastAudibleAt: {} });
    expect(result.warning).toBe('all-silent');
  });

  it('summarizes the streams observed during a stopped recording', () => {
    expect(captureSummary(new Set(['mic']))).toBe('Captured microphone audio only');
    expect(captureSummary(new Set(['mic', 'system', 'mixed']))).toBe('Captured microphone and app audio');
    expect(captureSummary(new Set())).toBe('No audible audio was detected');
  });

  it('tells callback starvation apart from a quiet call', () => {
    const base = { startedAtMs: 0, nowMs: 30_000, lastAudibleAt: { mic: 29_000, mixed: 29_000 } };
    // App samples arrive but are silent: quiet participants.
    expect(deriveCaptureHealth({ ...base, received: { mic: true, system: true, mixed: true } }).warning).toBe('app-silent');
    // No app sample has ever arrived: the capture callback is starved.
    const starved = deriveCaptureHealth({ ...base, received: { mic: true, mixed: true } });
    expect(starved.warning).toBe('app-starved');
    expect(starved.message).toMatch(/not a quiet call/);
    // Still inside the startup grace period: no verdict yet.
    expect(deriveCaptureHealth({ ...base, nowMs: 2_000, received: { mic: true } }).state).toBe('checking');
    // Callers that do not track received samples keep the old behaviour.
    expect(deriveCaptureHealth(base).warning).toBe('app-silent');
  });
});
