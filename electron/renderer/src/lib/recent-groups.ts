const key = 'libraryRecentMoveGroups';
export function recentGroups(): (string | null)[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw)
      ? [
          ...new Set(
            raw.filter((id): id is string | null => id === null || typeof id === 'string'),
          ),
        ].slice(0, 3)
      : [];
  } catch {
    return [];
  }
}
export function rememberDestination(id: string | null): void {
  try {
    localStorage.setItem(
      key,
      JSON.stringify([id, ...recentGroups().filter((old) => old !== id)].slice(0, 3)),
    );
  } catch {
    /* session move remains successful */
  }
}
export function pruneDestinations(ids: readonly string[]): void {
  try {
    localStorage.setItem(
      key,
      JSON.stringify(recentGroups().filter((id) => id === null || ids.includes(id))),
    );
  } catch {
    /* optional preference */
  }
}
