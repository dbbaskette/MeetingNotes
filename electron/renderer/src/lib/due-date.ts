/** Tier used to style an action item's due-date chip in the Weekly view.
 *  `overdue` is judged against the real current date (`now`), independent
 *  of which week is being browsed — an item from three weeks ago is
 *  overdue even if the user is looking at last week's rollup. */
export type DueTier = 'overdue' | 'this-week' | 'later' | 'none';

export interface DueLabel {
  label: string;
  tier: DueTier;
}

/** Truncate to a date-only ISO string so same-day comparisons don't get
 *  tripped up by time-of-day (a task due "today" should not read as
 *  overdue just because it's already 3pm). */
function dateOnly(d: Date): number {
  return new Date(d.toISOString().slice(0, 10)).getTime();
}

export function fmtDueLabel(due: string | null, rangeEnd: string, now: Date = new Date()): DueLabel {
  if (!due) return { label: 'No due date', tier: 'none' };
  const dueT = new Date(due).getTime();
  const endT = new Date(rangeEnd).getTime();
  const todayT = dateOnly(now);
  const tier: DueTier = dueT < todayT ? 'overdue' : dueT <= endT ? 'this-week' : 'later';
  const fmtDate = (): string =>
    new Date(due).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  const label = tier === 'overdue' ? `Overdue — was due ${fmtDate()}` : `Due ${fmtDate()}`;
  return { label, tier };
}
