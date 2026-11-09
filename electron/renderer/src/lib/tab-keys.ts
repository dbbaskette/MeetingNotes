/** Index a tab-list key press moves to, or null when the key is not a tab key. */
export function nextTabIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
