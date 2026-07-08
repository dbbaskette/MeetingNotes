// electron/renderer/src/lib/selection.ts
//
// Pure selection logic for the Library's bulk-action bar. Every row is
// selectable; Process only acts on the pending rows within the selection,
// Delete acts on all of them. Kept out of the component for unit testing
// (the renderer has no DOM test harness).

export interface SelectableMeeting {
  id: string;
  status: string;
}

/** Drop selected ids that no longer exist in the meetings list (e.g. the
 *  row was deleted elsewhere or purged). Returns the SAME set instance
 *  when nothing changed, so a React state setter can bail out of a
 *  re-render. */
export function pruneSelection(
  prev: Set<string>,
  meetings: readonly SelectableMeeting[],
): Set<string> {
  const valid = new Set(meetings.map((m) => m.id));
  let changed = false;
  const next = new Set<string>();
  for (const id of prev) {
    if (valid.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : prev;
}

/** Split a selection into what each bulk action operates on:
 *   - pendingIds: only rows with status 'pending' — the Process target.
 *   - allIds:     every selected row that still exists — the Delete target.
 *  Both preserve the meetings-list order (not Set insertion order) so the
 *  actions run in the same order the user sees on screen. */
export function partitionSelection(
  selected: ReadonlySet<string>,
  meetings: readonly SelectableMeeting[],
): { pendingIds: string[]; allIds: string[] } {
  const pendingIds: string[] = [];
  const allIds: string[] = [];
  for (const m of meetings) {
    if (!selected.has(m.id)) continue;
    allIds.push(m.id);
    if (m.status === 'pending') pendingIds.push(m.id);
  }
  return { pendingIds, allIds };
}
