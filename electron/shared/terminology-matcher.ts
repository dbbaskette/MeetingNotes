import type { TermMatch, TermRule } from './terminology.js';

const word = /[\p{L}\p{N}\p{M}_]/u;
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ranges are retained, rather than stripping markup and changing offsets. */
export function proseRanges(text: string): Array<[number, number]> {
  const blocked: Array<[number, number]> = [];
  const patterns = [
    /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/g,
    /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g,
    /\]\([^\n)]*\)/g,
    /(?:https?:\/\/|www\.)[^\s<>]+/g,
    /^\[[^\]\n]+\s\d+:\d+(?::\d+)?\]\s*/gm,
    /^ {4}[^\n]*$/gm,
    /<[^>\n]*>/g,
    /^\[[^\]\n]+\]:[^\n]*$/gm,
  ];
  for (const regex of patterns)
    for (const m of text.matchAll(regex)) {
      blocked.push([m.index!, m.index! + m[0].length]);
    }
  blocked.sort((a, b) => a[0] - b[0]);
  const ranges: Array<[number, number]> = [];
  let at = 0;
  for (const [start, end] of blocked) {
    if (start > at) ranges.push([at, start]);
    at = Math.max(at, end);
  }
  if (at < text.length) ranges.push([at, text.length]);
  return ranges;
}

export function findTerms(
  units: readonly string[],
  rules: readonly TermRule[],
  limit = 2000,
): TermMatch[] {
  const matches: TermMatch[] = [];
  if (!rules.length) return matches;
  // Group scope outranks library scope, then prefer longer phrases. One pass
  // over ORIGINAL text means replacement output can never trigger another rule.
  const ordered = [...rules]
    .filter((r) => r.enabled)
    .sort(
      (a, b) =>
        Number(b.groupId !== null) - Number(a.groupId !== null) ||
        b.source.length - a.source.length ||
        a.id.localeCompare(b.id),
    );
  const compiled = ordered.map((rule) => ({
    rule,
    regex: new RegExp(
      escape(rule.source).replace(/\s+/g, '[ \\t]+'),
      rule.caseSensitive ? 'gu' : 'giu',
    ),
  }));
  let work = 0;
  for (let unit = 0; unit < units.length; unit++) {
    const text = units[unit]!;
    const ranges = proseRanges(text);
    const occupied: Array<[number, number]> = [];
    for (const { rule, regex } of compiled) {
      work += text.length;
      if (work > 100_000_000)
        throw new Error(
          'Too many terms for this document. Narrow the dictionary scope or preview one term at a time.',
        );
      for (const m of text.matchAll(regex)) {
        const start = m.index!,
          end = start + m[0].length;
        if (m[0] === rule.replacement) continue;
        const before = [...text.slice(Math.max(0, start - 2), start)].at(-1) ?? '';
        const after = String.fromCodePoint(text.codePointAt(end) ?? 32);
        if (
          (word.test([...rule.source][0]!) && word.test(before)) ||
          (word.test([...rule.source].at(-1)!) && word.test(after))
        )
          continue;
        if (!ranges.some(([a, b]) => start >= a && end <= b)) continue;
        if (occupied.some(([a, b]) => start < b && end > a)) continue;
        occupied.push([start, end]);
        matches.push({
          key: `${unit}:${start}:${rule.id}:${rule.revision}`,
          unit,
          start,
          before: m[0],
          after: rule.replacement,
          context: text.slice(Math.max(0, start - 60), Math.min(text.length, end + 60)),
          ruleId: rule.id === 'manual' ? null : rule.id,
          ruleRevision: rule.id === 'manual' ? null : rule.revision,
        });
        if (matches.length >= limit) {
          if (limit > 2000)
            throw new Error(
              'Too many automatic replacements in this document. Use occurrence review instead.',
            );
          return matches;
        }
      }
    }
  }
  return matches.sort((a, b) => a.unit - b.unit || a.start - b.start);
}

export interface TermCandidate {
  source: string;
  replacement: string;
}
/** Conservative aligned-line/token comparison, bounded to keep save responsive.
 * Rewrites and ambiguous insert/delete alignment are deliberately not learned. */
export function correctionCandidates(before: string, after: string): TermCandidate[] {
  if (before.length + after.length > 200_000) return [];
  const a = before.split('\n'),
    b = after.split('\n');
  if (a.length !== b.length) return [];
  const out = new Map<string, TermCandidate>();
  const eligible = (s: string): boolean =>
    s.length > 0 &&
    s.length <= 80 &&
    /\p{L}/u.test(s) &&
    !/[\n`<>[\]{}*#=/]/.test(s) &&
    s.split(/\s+/).length <= 5;
  const rangesA = proseRanges(before),
    rangesB = proseRanges(after);
  let offsetA = 0,
    offsetB = 0;
  for (let line = 0; line < a.length; line++) {
    const startA = offsetA,
      startB = offsetB;
    offsetA += a[line]!.length + 1;
    offsetB += b[line]!.length + 1;
    if (a[line] === b[line]) continue;
    // Ignore protected markup changes, including fenced code on other lines.
    const aa = a[line]!.match(/\S+/g) ?? [],
      bb = b[line]!.match(/\S+/g) ?? [];
    if (Math.max(aa.length, bb.length) > 1000) continue;
    const pairs: Array<[string, string]> = [];
    if (aa.length === bb.length) {
      const changed = aa.flatMap((v, i) => (v !== bb[i] ? [i] : []));
      if (changed.length > 5 || (changed.length > 1 && changed.length / aa.length > 0.35)) continue;
      for (const i of changed) pairs.push([aa[i]!, bb[i]!]);
    } else {
      let prefix = 0,
        suffix = 0;
      while (prefix < Math.min(aa.length, bb.length) && aa[prefix] === bb[prefix]) prefix++;
      while (
        suffix < Math.min(aa.length, bb.length) - prefix &&
        aa[aa.length - 1 - suffix] === bb[bb.length - 1 - suffix]
      )
        suffix++;
      // Two unchanged anchors make a short many-to-one substitution meaningful;
      // insertions, deletions and rewritten sentences remain ineligible.
      if (!prefix || !suffix) continue;
      const left = aa.slice(prefix, aa.length - suffix),
        right = bb.slice(prefix, bb.length - suffix);
      if (
        !left.length ||
        !right.length ||
        Math.max(left.length, right.length) > 5 ||
        left.length + right.length > prefix + suffix + 2
      )
        continue;
      pairs.push([left.join(' '), right.join(' ')]);
    }
    for (const [from, to] of pairs) {
      const source = from.replace(/^[,.;:!?"'“”‘’(]+|[,.;:!?"'“”‘’)]+$/g, '');
      const replacement = to.replace(/^[,.;:!?"'“”‘’(]+|[,.;:!?"'“”‘’)]+$/g, '');
      if (!eligible(source) || !eligible(replacement) || source === replacement) continue;
      const posA = a[line]!.indexOf(source),
        posB = b[line]!.indexOf(replacement);
      if (
        posA < 0 ||
        posB < 0 ||
        !rangesA.some(([x, y]) => startA + posA >= x && startA + posA + source.length <= y) ||
        !rangesB.some(([x, y]) => startB + posB >= x && startB + posB + replacement.length <= y)
      )
        continue;
      out.set(`${source}\0${replacement}`, { source, replacement });
      if (out.size > 10) return [];
    }
  }
  return [...out.values()].filter(
    (c) =>
      ![...out.values()].some(
        (other) =>
          other.source.toLowerCase() === c.source.toLowerCase() &&
          other.replacement !== c.replacement,
      ),
  );
}
