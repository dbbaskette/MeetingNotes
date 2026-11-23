// electron/renderer/src/lib/line-diff.ts
//
// Line-level diff for the Notes history and Obsidian conflict comparisons
// (#299). Both showed two full copies of a document side by side and left
// the reader to spot what changed. This marks lines as kept, removed or
// added with a longest-common-subsequence over lines.
export type DiffOp = 'same' | 'removed' | 'added';
export interface DiffLine { op: DiffOp; text: string }

/** Above this many line pairs the quadratic table is not worth building; the
 *  documents are shown as wholesale removed-then-added instead. */
export const LINE_DIFF_MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split(/\r?\n/), b = after === '' ? [] : after.split(/\r?\n/);
  // Common prefix and suffix are free, and keep the table small for the usual
  // case of a few edited lines in a long note.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ op: 'same', text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ op: 'same', text }));
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const removedAll = (): DiffLine[] => [
    ...midA.map((text): DiffLine => ({ op: 'removed', text })), ...midB.map((text): DiffLine => ({ op: 'added', text }))];
  if (midA.length === 0 || midB.length === 0 || midA.length * midB.length > LINE_DIFF_MAX_CELLS) return [...head, ...removedAll(), ...tail];

  // lcs[i][j] = length of the LCS of midA[i..] and midB[j..].
  const rows = midA.length + 1, cols = midB.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lcs[i * cols + j] = midA[i] === midB[j] ? lcs[(i + 1) * cols + j + 1]! + 1 : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + j + 1]!);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) { middle.push({ op: 'same', text: midA[i]! }); i++; j++; }
    else if (lcs[(i + 1) * cols + j]! >= lcs[i * cols + j + 1]!) middle.push({ op: 'removed', text: midA[i++]! });
    else middle.push({ op: 'added', text: midB[j++]! });
  }
  while (i < midA.length) middle.push({ op: 'removed', text: midA[i++]! });
  while (j < midB.length) middle.push({ op: 'added', text: midB[j++]! });
  return [...head, ...middle, ...tail];
}

export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of lines) { if (line.op === 'added') added++; else if (line.op === 'removed') removed++; }
  return { added, removed };
}

/** Collapse long runs of unchanged lines to `context` lines either side of a
 *  change, so the differences are found without scrolling a whole document.
 *  A collapsed run is one entry with `skipped` set. */
export interface DiffRow { op: DiffOp | 'gap'; text: string; skipped?: number }
export function collapseUnchanged(lines: readonly DiffLine[], context = 3): DiffRow[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((line, index) => {
    if (line.op === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = 1;
  });
  const out: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) { out.push({ op: 'gap', text: '', skipped }); skipped = 0; }
      out.push(line);
    } else skipped++;
  });
  if (skipped) out.push({ op: 'gap', text: '', skipped });
  return out;
}
