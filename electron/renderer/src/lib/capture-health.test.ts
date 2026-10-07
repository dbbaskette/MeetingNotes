import { describe, expect, it } from 'vitest';
import { captureSummary, deriveCaptureHealth } from './capture-health.js';

const startedAtMs = 1_000;

describe('deriveCaptureHealth', () => {
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
});
