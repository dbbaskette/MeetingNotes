import type { TermRule } from '../../../shared/terminology';

/** '*' is every scope; '' is library-wide only; otherwise match the group exactly. */
export function filterDictionaryRules(rules: TermRule[], query: string, scope: string): TermRule[] {
  const needle = query.trim().toLocaleLowerCase();
  return rules.filter(
    (rule) =>
      (scope === '*' || (rule.groupId ?? '') === scope) &&
      `${rule.source} ${rule.replacement}`.toLocaleLowerCase().includes(needle),
  );
}
