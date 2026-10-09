import { describe, it, expect } from 'vitest';
import { buildErrorReport, formatErrorDetails, shouldResetBoundary } from './error-report';

describe('buildErrorReport', () => {
  it('captures name, message, stack and component stack from an Error', () => {
    const err = new TypeError('x is not a function');
    const report = buildErrorReport('boundary', 'detail:notes', err, '\n    at Notes\n    at Detail\n');
    expect(report.source).toBe('boundary');
    expect(report.scope).toBe('detail:notes');
    expect(report.message).toBe('TypeError: x is not a function');
    expect(report.stack).toContain('x is not a function');
    expect(report.componentStack).toBe('at Notes\n    at Detail');
  });

  it('handles thrown strings and unknown values', () => {
    expect(buildErrorReport('promise', 'window', 'plain').message).toBe('plain');
    expect(buildErrorReport('window', 'window', { odd: true })).toEqual({ source: 'window', scope: 'window', message: 'Unknown error' });
  });
});

describe('formatErrorDetails', () => {
  it('lists version, scope, message and stacks', () => {
    const text = formatErrorDetails({ source: 'boundary', scope: 'library', message: 'Error: boom', stack: 'at A', componentStack: 'at B' }, '1.2.3');
    expect(text).toBe('MeetingNotes 1.2.3 — library\n\nError: boom\n\nat A\n\nComponent stack:\nat B');
  });

  it('omits missing parts', () => {
    expect(formatErrorDetails({ source: 'window', scope: 'window', message: 'Error: boom' })).toBe('MeetingNotes — window\n\nError: boom');
  });
});

describe('shouldResetBoundary', () => {
  it('resets only when failed and the key changed', () => {
    expect(shouldResetBoundary(true, 'detail:a', 'detail:b')).toBe(true);
    expect(shouldResetBoundary(true, 'detail:a', 'detail:a')).toBe(false);
    expect(shouldResetBoundary(false, 'detail:a', 'detail:b')).toBe(false);
  });
});
