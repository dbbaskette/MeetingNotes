import { describe, it, expect } from 'vitest';
import { extractJsonBlock, parseNarrativeResponse, buildUserPrompt } from './prompt.js';

describe('extractJsonBlock', () => {
  it('returns the input unchanged when it is already a clean JSON object', () => {
    const raw = '{"narrative":"hi","decisions":[]}';
    expect(extractJsonBlock(raw)).toBe(raw);
  });

  it('strips a ```json ... ``` code fence', () => {
    const raw = '```json\n{"narrative":"hi","decisions":[]}\n```';
    expect(extractJsonBlock(raw)).toBe('{"narrative":"hi","decisions":[]}');
  });

  it('strips an unlabeled ``` code fence', () => {
    const raw = '```\n{"narrative":"hi","decisions":[]}\n```';
    expect(extractJsonBlock(raw)).toBe('{"narrative":"hi","decisions":[]}');
  });

  it('strips leading prose intro before the first {', () => {
    const raw = 'Sure! Here is the JSON:\n{"narrative":"hi","decisions":[]}';
    expect(extractJsonBlock(raw)).toBe('{"narrative":"hi","decisions":[]}');
  });

  it('strips trailing prose after the closing }', () => {
    const raw = '{"narrative":"hi","decisions":[]}\nLet me know if you need anything else.';
    expect(extractJsonBlock(raw)).toBe('{"narrative":"hi","decisions":[]}');
  });

  it('handles nested braces in narrative without truncating', () => {
    const raw = '{"narrative":"This week we discussed {object} schemas.","decisions":[]}';
    // The walker tracks brace depth so an inner '{' doesn't end the
    // top-level object early. Closing brace count must still match.
    expect(extractJsonBlock(raw)).toBe(raw);
  });
});

describe('parseNarrativeResponse', () => {
  it('parses a clean response', () => {
    const out = parseNarrativeResponse('{"narrative":"focus was Q2","decisions":["X — Mtg A","Y — Mtg B"]}');
    expect(out.narrative).toBe('focus was Q2');
    expect(out.decisions).toEqual(['X — Mtg A', 'Y — Mtg B']);
  });

  it('drops empty / non-string entries from decisions', () => {
    const out = parseNarrativeResponse('{"narrative":"x","decisions":["A","",null,42,"B"]}');
    expect(out.decisions).toEqual(['A', 'B']);
  });

  it('throws when narrative is missing or empty', () => {
    expect(() => parseNarrativeResponse('{"narrative":"","decisions":[]}'))
      .toThrow(/empty narrative/);
    expect(() => parseNarrativeResponse('{"decisions":[]}'))
      .toThrow(/empty narrative/);
  });

  it('throws on invalid JSON with a snippet of the offending text', () => {
    expect(() => parseNarrativeResponse('not json at all'))
      .toThrow(/invalid JSON/);
  });

  it('throws on a non-object response', () => {
    expect(() => parseNarrativeResponse('"just a string"'))
      .toThrow();
  });

  it('parses well-formed themes with source meetings', () => {
    const out = parseNarrativeResponse(JSON.stringify({
      narrative: 'x',
      themes: [
        { title: 'Migration', detail: 'Discussed fixtures.', meetings: ['Eng sync', 'Q2 planning'] },
      ],
      decisions: [],
    }));
    expect(out.themes).toEqual([
      { title: 'Migration', detail: 'Discussed fixtures.', meetings: ['Eng sync', 'Q2 planning'] },
    ]);
  });

  it('defaults themes to [] when the field is missing', () => {
    const out = parseNarrativeResponse('{"narrative":"x","decisions":[]}');
    expect(out.themes).toEqual([]);
  });

  it('drops themes missing a title or detail and coerces meetings', () => {
    const out = parseNarrativeResponse(JSON.stringify({
      narrative: 'x',
      themes: [
        { title: 'Good', detail: 'has both', meetings: ['A', '', 3, 'B'] },
        { title: '', detail: 'no title' },
        { title: 'no detail' },
        { detail: 'no title either' },
        'not an object',
      ],
      decisions: [],
    }));
    expect(out.themes).toEqual([
      { title: 'Good', detail: 'has both', meetings: ['A', 'B'] },
    ]);
  });

  it('defaults a theme with no meetings array to an empty list', () => {
    const out = parseNarrativeResponse(JSON.stringify({
      narrative: 'x',
      themes: [{ title: 'T', detail: 'D' }],
      decisions: [],
    }));
    expect(out.themes[0]!.meetings).toEqual([]);
  });
});

describe('buildUserPrompt', () => {
  it('lays out meetings and actions in a stable readable shape', () => {
    const out = buildUserPrompt({
      weekLabel: 'Apr 21 – 25, 2026',
      meetings: [
        { title: 'Q2 planning', startedAt: '2026-04-21T10:00:00Z', durationS: 45 * 60, summaryMd: '## Overview\nDiscussed roadmap.' },
      ],
      openActions: [
        { owner: 'You', text: 'Send SOC2 doc', due: '2026-04-25' },
      ],
    });
    expect(out).toContain('Q2 planning');
    expect(out).toContain('Discussed roadmap');
    expect(out).toContain('[You] Send SOC2 doc');
    expect(out).toContain('Apr 21 – 25, 2026');
  });

  it('prints "(no meetings this week)" when the week is empty', () => {
    const out = buildUserPrompt({
      weekLabel: 'Apr 28 – May 2, 2026',
      meetings: [],
      openActions: [],
    });
    expect(out).toContain('(no meetings this week)');
    expect(out).toContain('(none)'); // for actions
  });
});
