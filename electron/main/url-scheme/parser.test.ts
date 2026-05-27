import { describe, it, expect } from 'vitest';
import { parseSchemeUrl, looksLikeBundleId } from './parser.js';

describe('parseSchemeUrl', () => {
  it('parses record with no params as source=all', () => {
    const r = parseSchemeUrl('meetingnotes://record');
    expect(r).toEqual({ kind: 'record', source: 'all', title: null });
  });

  it('accepts the slash-less form (meetingnotes:record)', () => {
    const r = parseSchemeUrl('meetingnotes:record');
    expect(r).toMatchObject({ kind: 'record' });
  });

  it('parses record with source + title', () => {
    const r = parseSchemeUrl('meetingnotes://record?source=zoom&title=Standup');
    expect(r).toEqual({ kind: 'record', source: 'zoom', title: 'Standup' });
  });

  it('parses record with a bundle id as source', () => {
    const r = parseSchemeUrl('meetingnotes://record?source=us.zoom.xos');
    expect(r).toMatchObject({ kind: 'record', source: 'us.zoom.xos' });
  });

  it('rejects record with an invalid source (spaces / shell chars)', () => {
    expect(parseSchemeUrl('meetingnotes://record?source=zoom%20rm')).toMatchObject({ kind: 'error' });
    expect(parseSchemeUrl('meetingnotes://record?source=$(whoami)')).toMatchObject({ kind: 'error' });
  });

  it('parses stop', () => {
    expect(parseSchemeUrl('meetingnotes://stop')).toEqual({ kind: 'stop' });
  });

  it('parses open with an id', () => {
    expect(parseSchemeUrl('meetingnotes://open?id=4d3a1c')).toEqual({ kind: 'open', meetingId: '4d3a1c' });
  });

  it('rejects open without an id', () => {
    expect(parseSchemeUrl('meetingnotes://open')).toMatchObject({ kind: 'error' });
  });

  it('rejects open with an invalid id', () => {
    expect(parseSchemeUrl('meetingnotes://open?id=foo bar')).toMatchObject({ kind: 'error' });
  });

  it('rejects an unknown verb', () => {
    expect(parseSchemeUrl('meetingnotes://launch')).toMatchObject({ kind: 'error', reason: /unknown verb/ });
  });

  it('rejects a non-meetingnotes scheme', () => {
    expect(parseSchemeUrl('https://example.com/record')).toMatchObject({ kind: 'error' });
  });

  it('rejects a syntactically invalid URL', () => {
    expect(parseSchemeUrl('not a url')).toMatchObject({ kind: 'error' });
  });

  it('caps title length to 200 chars', () => {
    const long = 'x'.repeat(201);
    expect(parseSchemeUrl(`meetingnotes://record?title=${long}`)).toMatchObject({ kind: 'error' });
  });
});

describe('looksLikeBundleId', () => {
  it('treats reverse-DNS strings as bundle ids', () => {
    expect(looksLikeBundleId('us.zoom.xos')).toBe(true);
    expect(looksLikeBundleId('com.microsoft.teams2')).toBe(true);
  });
  it('treats short keywords as not-bundle-ids', () => {
    expect(looksLikeBundleId('zoom')).toBe(false);
    expect(looksLikeBundleId('teams')).toBe(false);
    expect(looksLikeBundleId('all')).toBe(false);
  });
});
