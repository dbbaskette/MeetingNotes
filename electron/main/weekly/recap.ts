// electron/main/weekly/recap.ts
//
// Pure helper: pull a short multi-sentence recap out of a meeting's
// summary.md for the weekly view's per-meeting line. The summarizing
// stage writes an "## Overview" section first whose opening paragraph is
// already a tight 2-3 sentence overview — exactly what we want for recall
// — so we extract that rather than paying an LLM to re-summarize what's
// already a click away in the meeting's own summary.

/** Extract up to `maxSentences` sentences (capped at `maxChars`) from the
 *  Overview paragraph of a summary.md. Falls back to the first non-heading
 *  paragraph when there's no Overview heading. Returns null when there's
 *  no usable prose. */
export function extractOverviewRecap(
  summaryMd: string | null | undefined,
  maxSentences = 3,
  maxChars = 320,
): string | null {
  if (!summaryMd) return null;

  const para = firstOverviewParagraph(summaryMd) ?? firstBodyParagraph(summaryMd);
  if (!para) return null;

  // Take up to maxSentences sentences.
  const sentences = para.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  let recap = sentences.slice(0, maxSentences).join(' ').trim();
  if (!recap) return null;

  if (recap.length > maxChars) {
    const cut = recap.slice(0, maxChars);
    // Avoid splitting mid-word: trim back to the last space.
    const lastSpace = cut.lastIndexOf(' ');
    recap = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
  }
  return recap;
}

/** First paragraph under a `## Overview` heading, or null. */
function firstOverviewParagraph(md: string): string | null {
  // Split on level-2 headings; find the Overview section body.
  const sections = md.split(/^##\s+/m).slice(1);
  const overview = sections.find((s) => /^overview\b/i.test(s.trim()));
  if (!overview) return null;
  const body = overview.replace(/^overview[^\n]*\n+/i, '').trim();
  return firstParagraph(body);
}

/** First non-heading, non-empty paragraph in the document. */
function firstBodyParagraph(md: string): string | null {
  const withoutHeadings = md
    .split('\n')
    .filter((line) => !/^#{1,6}\s/.test(line))
    .join('\n');
  return firstParagraph(withoutHeadings);
}

/** First blank-line-delimited paragraph of a block of text, collapsed to a
 *  single line. Null when the block is empty. */
function firstParagraph(text: string): string | null {
  const para = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0);
  if (!para) return null;
  return para.replace(/\s*\n\s*/g, ' ').trim() || null;
}
