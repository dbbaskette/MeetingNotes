interface VirtualWindowInput {
  count: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan: number;
}

/** Fixed-height slots, with an exclusive end index. Clamp stale scroll
 * positions after resize/removal before computing the visible range. */
export function virtualWindow({ count, rowHeight, scrollTop, viewportHeight, overscan }: VirtualWindowInput): {
  start: number; end: number; offset: number; totalHeight: number;
} {
  const totalHeight = count * rowHeight;
  const height = Math.max(0, viewportHeight);
  const top = Math.max(0, Math.min(scrollTop, totalHeight - height));
  const extra = Math.max(0, Math.min(count, Math.floor(overscan)));
  const start = Math.max(0, Math.floor(top / rowHeight) - extra);
  const end = Math.min(count, Math.ceil((top + height) / rowHeight) + extra);
  return { start, end, offset: start * rowHeight, totalHeight };
}

/** Add only retained owners to the visible slots, preserving DOM order and
 * stable ID ownership after refresh/reorder. Focus and dialogs may share a pin. */
export function retainedRowIndexes({ items, start, end, retainedIds }: {
  items: readonly { id: string }[];
  start: number;
  end: number;
  retainedIds: Iterable<string>;
}): number[] {
  const indexes = new Set(Array.from({ length: end - start }, (_, index) => start + index));
  for (const id of retainedIds) {
    const index = items.findIndex((item) => item.id === id);
    if (index >= 0) indexes.add(index);
  }
  return [...indexes].sort((a, b) => a - b);
}

/** J/K list movement. Nothing focused → j lands on the first row, k on the
 *  last. Clamps at the ends so the virtual window can scroll the owner in. */
export function stepMeetingIndex(
  count: number,
  current: number | null,
  delta: 1 | -1,
): number | null {
  if (count <= 0) return null;
  if (current === null) return delta === 1 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, current + delta));
}
