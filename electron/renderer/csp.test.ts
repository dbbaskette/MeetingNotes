import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CSP_DIRECTIVES, contentSecurityPolicy } from './csp';

describe('renderer Content-Security-Policy', () => {
  it('denies by default and never allows inline or evaluated scripts', () => {
    expect(CSP_DIRECTIVES['default-src']).toEqual(["'none'"]);
    expect(CSP_DIRECTIVES['script-src']).toEqual(["'self'"]);
    expect(contentSecurityPolicy()).not.toMatch(/unsafe-eval/);
    expect(CSP_DIRECTIVES['object-src']).toEqual(["'none'"]);
    expect(CSP_DIRECTIVES['base-uri']).toEqual(["'none'"]);
  });

  it('allows no network access from the renderer at all', () => {
    const remote = Object.values(CSP_DIRECTIVES).flat().filter((source) => /^https?:|^wss?:|^\*/.test(source));
    expect(remote).toEqual([]);
    expect(CSP_DIRECTIVES['connect-src']).toEqual(["'self'"]);
    expect(contentSecurityPolicy()).not.toMatch(/huggingface/);
  });

  it('gives the beta audio protocol to the beta page only', () => {
    expect(contentSecurityPolicy()).not.toMatch(/beta-audio:/);
    expect(contentSecurityPolicy('app')).not.toMatch(/beta-audio:/);
    expect(contentSecurityPolicy('beta')).toMatch(/media-src [^;]*beta-audio:/);
  });

  it('covers every audio source the app plays', () => {
    expect(CSP_DIRECTIVES['media-src']).toEqual(expect.arrayContaining(['file:', 'data:', 'recovery-audio:']));
  });

  it('serializes to a single header value', () => {
    expect(contentSecurityPolicy()).toMatch(/^default-src 'none'; script-src 'self'; /);
  });

  it('has no inline script left in index.html for the policy to block', () => {
    const html = readFileSync(path.resolve(__dirname, 'index.html'), 'utf8');
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
    expect(inline).toEqual([]);
  });
});
