export function rowAt(offsets: readonly number[], position: number): number {
  let low = 0,
    high = offsets.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (offsets[middle]! <= position) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}
export function rowOffsets(
  count: number,
  estimate: (index: number) => number,
  measured: ReadonlyMap<number, number>,
): number[] {
  const offsets = [0];
  for (let index = 0; index < count; index++)
    offsets.push(offsets[index]! + (measured.get(index) ?? estimate(index)));
  return offsets;
}
