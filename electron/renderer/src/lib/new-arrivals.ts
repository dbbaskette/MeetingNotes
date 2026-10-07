const key = 'libraryNewAcknowledgedAt';
/** First upgrade establishes a baseline; only explicit acknowledgment advances it. */
export function arrivalBaseline(now = new Date().toISOString()): string {
  try {
    const previous = localStorage.getItem(key);
    if (previous && Number.isFinite(Date.parse(previous))) return previous;
    localStorage.setItem(key, now);
  } catch {
    /* markers still work for this visit */
  }
  return now;
}
export function acknowledgeArrivals(now = new Date().toISOString()): string {
  try {
    localStorage.setItem(key, now);
  } catch {
    /* session state is retained */
  }
  return now;
}
