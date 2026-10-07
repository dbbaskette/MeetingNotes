import { expect, it } from 'vitest';
import { effectiveLlmUrl, isIdleProbe, resolveWhisperEndpoint } from './inference-endpoints.js';
import { probeError } from '../main/ipc/probe-error.js';

it('probes the active provider, including external custom endpoints', () => {
  expect(effectiveLlmUrl('lm-studio', 'http://custom.test')).toBe('http://127.0.0.1:1234');
  expect(effectiveLlmUrl('ollama', 'http://custom.test')).toBe('http://127.0.0.1:11434');
  expect(effectiveLlmUrl('external', 'http://custom.test')).toBe('http://custom.test');
});
it('only treats connection refusal on managed endpoints as idle', () => {
  for (const url of ['http://localhost:8080', 'http://[::1]:8080']) {
    expect(isIdleProbe(resolveWhisperEndpoint(url).kind === 'managed', 'ECONNREFUSED')).toBe(true);
  }
  for (const url of ['https://localhost:8080', 'http://remote.test', 'http://localhost:8080/proxy']) {
    expect(isIdleProbe(resolveWhisperEndpoint(url).kind === 'managed', 'ECONNREFUSED')).toBe(false);
  }
  for (const code of [undefined, 'ENOTFOUND', 'CERT_HAS_EXPIRED', 'ETIMEDOUT']) expect(isIdleProbe(true, code)).toBe(false);
});
it('preserves nested fetch error codes without classifying generic failures as refusal', () => {
  expect(probeError(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))).toEqual({ ok: false, error: 'connection refused', code: 'ECONNREFUSED' });
  expect(probeError(new TypeError('fetch failed'))).toEqual({ ok: false, error: 'fetch failed' });
  expect(probeError(new Error('TLS failed', { cause: { code: 'CERT_HAS_EXPIRED' } }))).toEqual({ ok: false, error: 'TLS failed', code: 'CERT_HAS_EXPIRED' });
});
