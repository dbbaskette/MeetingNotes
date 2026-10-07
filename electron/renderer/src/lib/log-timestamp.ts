/** Local timestamps for Diagnostics. Compare local calendar dates, not UTC
 * ISO prefixes, and keep older entries distinguishable across years. */
export function formatLogTimestamp(ts: string | null | undefined, now = new Date()): string {
  if (!ts) return '—';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '—';
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const time = date.toTimeString().slice(0, 8);
  if (sameDay) return time;
  const label = date.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
  });
  return `${label} ${time}`;
}
