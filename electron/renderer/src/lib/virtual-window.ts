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
