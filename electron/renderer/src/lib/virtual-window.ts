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
