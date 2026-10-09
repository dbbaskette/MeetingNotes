import { describe, it, expect } from 'vitest';
import { createReportLimiter, normalizeRendererError } from './renderer-error.js';

describe('normalizeRendererError', () => {
  it('accepts a well-formed report', () => {
    expect(normalizeRendererError({ source: 'boundary', scope: 'detail:notes', message: 'boom', stack: 'at X' }))
      .toEqual({ source: 'boundary', scope: 'detail:notes', message: 'boom', stack: 'at X' });
  });

  it('rejects malformed payloads', () => {
    expect(normalizeRendererError(null)).toBeNull();
    expect(normalizeRendererError({ source: 'other', scope: 'x', message: 'm' })).toBeNull();
    expect(normalizeRendererError({ source: 'window', scope: 'x'.repeat(81), message: 'm' })).toBeNull();
    expect(normalizeRendererError({ source: 'window', scope: 'x', message: 42 })).toBeNull();
  });

  it('truncates long messages and stacks', () => {
    const entry = normalizeRendererError({
      source: 'promise', scope: 'window', message: 'm'.repeat(2000), stack: 's'.repeat(9000), componentStack: 'c'.repeat(9000),
    })!;
    expect(entry.message).toHaveLength(501);
    expect(entry.stack).toHaveLength(4001);
    expect(entry.componentStack).toHaveLength(4001);
  });

  it('drops unknown fields', () => {
    const entry = normalizeRendererError({ source: 'window', scope: 'window', message: 'm', transcript: 'private' });
    expect(entry).toEqual({ source: 'window', scope: 'window', message: 'm' });
  });
});

describe('createReportLimiter', () => {
  it('allows a burst up to the limit, then recovers after the window', () => {
    let t = 0;
    const allow = createReportLimiter(3, 1000, () => t);
    expect([allow(), allow(), allow(), allow()]).toEqual([true, true, true, false]);
    t = 999;
    expect(allow()).toBe(false);
    t = 1000;
    expect(allow()).toBe(true);
  });
});
