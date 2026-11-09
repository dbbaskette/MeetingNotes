const KEY = 'needsAttentionCollapsed';
type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** One-line digest shown while the Needs attention inbox is collapsed. */
export function attentionSummary(groups: { label: string; totalCount: number }[]): string {
  return groups.map(group => `${group.totalCount} ${group.label.toLowerCase()}`).join(' · ');
}

export function readAttentionCollapsed(store?: Store): boolean {
  try { return (store ?? window.localStorage).getItem(KEY) === '1'; } catch { return false; }
}

export function saveAttentionCollapsed(collapsed: boolean, store?: Store): void {
  try { (store ?? window.localStorage).setItem(KEY, collapsed ? '1' : '0'); } catch { /* preference only */ }
}
