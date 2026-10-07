/** A calendar date, not an instant: never roundtrip through local DST. */
export function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === +match[1]! &&
    date.getUTCMonth() + 1 === +match[2]! &&
    date.getUTCDate() === +match[3]!
  );
}
