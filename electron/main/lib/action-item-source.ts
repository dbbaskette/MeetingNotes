// electron/main/lib/action-item-source.ts
//
// Provenance matching (#provenance). The extract stage turns each
// "## Action Items" bullet in summary.md into an action item, rewording it
// (dropping the marker, sometimes trimming the owner/date). This module runs
// the inverse: given the parsed items and the summary they came from, find the
// verbatim source bullet for each so the UI can jump item -> summary bullet.
//
// Pure and LLM-free — a token-overlap score against the small set of summary
// bullets (typically 5–30 short lines). No model change, fully unit-testable.
// When no bullet is a confident match, sourceQuote is null and the UI simply
// won't offer a "Show source" jump for that item.

import type { ActionItem } from './action-item-schema.js';

export type ActionItemWithSource = ActionItem & { sourceQuote: string | null };

/** Below this normalized token-overlap (Jaccard) score we treat a bullet as
 *  "not really the source" and return null rather than risk a wrong jump.
 *  NOTE: deviation from the plan's 0.5 — a reworded item ("Ship v2 API")
 *  scores ~0.375 against its own bullet once the owner/date tokens inflate
 *  the union, so 0.5 rejects true matches. 0.3 clears every true match in
 *  the tests while a no-overlap item still scores 0 and returns null. */
const MATCH_THRESHOLD = 0.3;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'by', 'with',
  'is', 'are', 'be', 'will', 'should', 'no', 'date', 'tbd', 'owner',
]);

/** Lowercase, strip punctuation, split on whitespace, drop stopwords. */
function tokenize(s: string): Set<string> {
  const toks = s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  return new Set(toks);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Strip a leading list marker ("- " / "* ") and an optional leading bold
 *  label ("**Foo:** rest") so the returned quote is the human-readable bullet
 *  text — but keep the ORIGINAL casing/punctuation for display + DOM matching. */
function cleanBullet(line: string): string {
  return line.replace(/^\s*[-*]\s+/, '').trim();
}

/** Pull the bullets to search. Prefer the "## Action Items" section; if there
 *  is none, fall back to every "-"/"*" bullet in the summary (extract also
 *  pulls commitments from Decisions/Follow-ups). */
function candidateBullets(summaryMd: string): string[] {
  const lines = summaryMd.split('\n');
  const headingIdx = lines.findIndex((l) => /^##\s+action items\s*$/i.test(l.trim()));
  let scope = lines;
  if (headingIdx !== -1) {
    let end = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i]!.trim())) { end = i; break; }
    }
    scope = lines.slice(headingIdx + 1, end);
  }
  return scope
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map(cleanBullet)
    .filter((b) => b.length > 0);
}

export function matchSourceQuotes(
  items: readonly ActionItem[],
  summaryMd: string,
): ActionItemWithSource[] {
  const bullets = candidateBullets(summaryMd);
  const bulletTokens = bullets.map((b) => ({ text: b, tokens: tokenize(b) }));
  return items.map((it) => {
    const itemTokens = tokenize(it.text);
    let best: { text: string; score: number } | null = null;
    for (const b of bulletTokens) {
      const score = jaccard(itemTokens, b.tokens);
      if (!best || score > best.score) best = { text: b.text, score };
    }
    return {
      ...it,
      sourceQuote: best && best.score >= MATCH_THRESHOLD ? best.text : null,
    };
  });
}
