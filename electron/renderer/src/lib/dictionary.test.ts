import { describe, expect, it } from 'vitest';
import { filterDictionaryRules } from './dictionary';
import type { TermRule } from '../../../shared/terminology';

const rules = [
  { id: '1', source: 'Salsa', replacement: 'SLSA', groupId: null },
  { id: '2', source: 'Cube', replacement: 'Kube', groupId: 'engineering' },
  { id: '3', source: 'Salsa', replacement: 'SLSA', groupId: 'security', enabled: false },
] as TermRule[];

describe('dictionary filtering', () => {
  it('includes all scopes and disabled rules by default without mutating the list', () => {
    expect(filterDictionaryRules(rules, '', '*')).toEqual(rules);
    expect(filterDictionaryRules(rules, '', '*')).not.toBe(rules);
  });
  it('searches original and corrected terms, ignoring case and surrounding spaces', () => {
    expect(filterDictionaryRules(rules, ' slsa ', '*').map((r) => r.id)).toEqual(['1', '3']);
    expect(filterDictionaryRules(rules, 'CUBE', '*').map((r) => r.id)).toEqual(['2']);
  });
  it('separates library-wide rules from exact group scopes', () => {
    expect(filterDictionaryRules(rules, '', '').map((r) => r.id)).toEqual(['1']);
    expect(filterDictionaryRules(rules, 'salsa', 'security').map((r) => r.id)).toEqual(['3']);
    expect(filterDictionaryRules(rules, 'salsa', 'engineering')).toEqual([]);
    expect(filterDictionaryRules(rules, '', 'missing')).toEqual([]);
  });
});
