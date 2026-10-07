import { describe, it, expect } from 'vitest';
import { correctionCandidates, findTerms } from './terminology-matcher.js';
import type { TermRule } from './terminology.js';
const rule = (source = 'Salsa', replacement = 'SLSA'): TermRule => ({
  id: source,
  source,
  replacement,
  groupId: null,
  mode: 'automatic',
  caseSensitive: false,
  enabled: true,
  revision: 1,
});
describe('terminology matching', () => {
  it('matches Unicode words and phrases without changing substrings or canonical case', () => {
    expect(
      findTerms(['Salsa, salsa; Salsalito Salsaé éSalsa SLSA'], [rule()]).map((m) => m.before),
    ).toEqual(['Salsa', 'salsa']);
    expect(findTerms(['café Cafe CAFÉ'], [rule('café', 'Café')]).map((m) => m.before)).toEqual([
      'café',
      'CAFÉ',
    ]);
    expect(findTerms(['Tanzu  platform'], [rule('Tanzu platform', 'Tanzu Platform')])).toHaveLength(
      1,
    );
  });
  it('protects Markdown code, destinations, URLs and speaker labels', () => {
    const text =
      '[Salsa 01:02] Salsa\n`Salsa` [Salsa](https://Salsa.test)\n```text\nSalsa\n```\n    Salsa\nhttps://Salsa.test\n[ref]: Salsa';
    expect(findTerms([text], [rule()]).map((m) => m.before)).toEqual(['Salsa', 'Salsa']);
  });
  it('selects nonoverlapping scoped phrases in one pass without cascading', () => {
    const terms = [
      rule('Salsa', 'SLSA'),
      rule('SLSA', 'Security'),
      { ...rule('Salsa level', 'SLSA level'), groupId: 'g' },
    ];
    const matches = findTerms(['Salsa level and Salsa'], terms);
    expect(matches.map((m) => m.after)).toEqual(['SLSA level', 'SLSA']);
  });
  it('supports case-sensitive rules', () => {
    expect(
      findTerms(['Salsa salsa'], [{ ...rule(), caseSensitive: true }]).map((m) => m.before),
    ).toEqual(['Salsa']);
  });
  it('protects multi-backtick spans and astral-letter word boundaries', () => {
    expect(findTerms(['``code ` Salsa here`` and Salsa'], [rule()])).toHaveLength(1);
    expect(findTerms(['𐐀word 𐐀'], [rule('𐐀', 'Term')])).toHaveLength(1);
  });
});
describe('learning candidates', () => {
  it('finds short substitutions including capitalization', () => {
    expect(correctionCandidates('Discuss Salsa today.', 'Discuss SLSA today.')).toEqual([
      { source: 'Salsa', replacement: 'SLSA' },
    ]);
    expect(correctionCandidates('Use slsa now.', 'Use SLSA now.')).toEqual([
      { source: 'slsa', replacement: 'SLSA' },
    ]);
    expect(
      correctionCandidates('We use tan zoo for deployments.', 'We use Tanzu for deployments.'),
    ).toEqual([{ source: 'tan zoo', replacement: 'Tanzu' }]);
  });
  it('ignores rewrites, formatting, numeric changes, URLs and fenced code', () => {
    for (const [a, b] of [
      ['We discussed a different design.', 'They will deploy the current system.'],
      ['Hello', '**Hello**'],
      ['Version 1', 'Version 2'],
      ['Use https://Salsa.test', 'Use https://SLSA.test'],
      ['```\nSalsa\n```', '```\nSLSA\n```'],
    ])
      expect(correctionCandidates(a!, b!)).toEqual([]);
  });
  it('bounds large edit detection', () => {
    expect(correctionCandidates('x'.repeat(200_001), 'SLSA')).toEqual([]);
  });
});
